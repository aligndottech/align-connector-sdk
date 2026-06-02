import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { LinearFetcher } from '../fetchers/linear.js';
import { NotionFetcher } from '../fetchers/notion.js';
import { ZoomFetcher } from '../fetchers/zoom.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Awaited<ReturnType<typeof fetch>>;
const text = (t: string) => ({ ok: true, status: 200, text: async () => t }) as unknown as Awaited<ReturnType<typeof fetch>>;

describe('LinearFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('dedups assigned+created issues and maps author = creator', async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        data: {
          viewer: {
            assignedIssues: {
              nodes: [
                {
                  id: 'i1',
                  title: 'Pick queue',
                  description: 'kafka vs sqs',
                  url: 'https://linear.app/i1',
                  state: { name: 'In Progress' },
                  team: { name: 'Infra' },
                  creator: { name: 'Ada', email: 'ada@x.io' },
                  comments: { nodes: [{ body: 'lean kafka', user: { name: 'Bob' } }] },
                },
              ],
            },
            createdIssues: { nodes: [{ id: 'i1', title: 'Pick queue', description: '', url: 'https://linear.app/i1' }] },
          },
        },
      }),
    );

    const items = await new LinearFetcher().fetch({ token: 'tok' });
    expect(items).toHaveLength(1); // deduped by id
    expect(items[0]).toMatchObject({ platform: 'linear', title: 'Pick queue', author: { name: 'Ada', email: 'ada@x.io' } });
    expect(items[0].raw_text).toContain('Bob: lean kafka');
  });

  it('surfaces GraphQL errors', async () => {
    mockFetch.mockResolvedValueOnce(ok({ errors: [{ message: 'bad token' }], data: null }));
    await expect(new LinearFetcher().fetch({ token: 'bad' })).rejects.toThrow(/bad token/);
  });
});

describe('NotionFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('maps pages with resolved creator + block text', async () => {
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/search'))
        return Promise.resolve(
          ok({ results: [{ id: 'abc-123', url: 'https://notion.so/abc', created_by: { id: 'u1' }, properties: { title: { title: [{ plain_text: 'Spec' }] } } }] }),
        );
      if (url.includes('/v1/users/'))
        return Promise.resolve(ok({ name: 'Carol', person: { email: 'carol@x.io' } }));
      if (url.includes('/blocks/'))
        return Promise.resolve(ok({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'decide on auth' }] } }] }));
      return Promise.resolve(ok({}));
    }));

    const items = await new NotionFetcher().fetch({ token: 'tok' });
    expect(items[0]).toMatchObject({ platform: 'notion', title: 'Spec', author: { name: 'Carol', email: 'carol@x.io' } });
    expect(items[0].raw_text).toContain('decide on auth');
  });
});

describe('ZoomFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('parses VTT transcripts and sets author = host', async () => {
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.includes('/users/me/recordings'))
        return Promise.resolve(
          ok({
            meetings: [
              {
                id: 1,
                uuid: 'abc==',
                topic: 'Planning',
                start_time: '2026-01-15T10:00:00Z',
                host_email: 'lead@x.io',
                recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/dl/1' }],
              },
            ],
          }),
        );
      if (url.includes('/dl/1')) return Promise.resolve(text('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nwe will ship friday\n'));
      return Promise.resolve(ok({}));
    }));

    const items = await new ZoomFetcher().fetch({ token: 'tok' });
    expect(items[0]).toMatchObject({ platform: 'zoom', author: { name: 'lead', email: 'lead@x.io' } });
    expect(items[0].raw_text).toContain('we will ship friday');
    expect(items[0].raw_text).not.toContain('-->');
    expect(items[0].title).toContain('Planning (2026-01-15)');
  });

  it('skips meetings without a completed transcript', async () => {
    mockFetch.mockResolvedValueOnce(ok({ meetings: [{ id: 1, uuid: 'u', topic: 't', start_time: '2026-01-01', recording_files: [] }] }));
    const items = await new ZoomFetcher().fetch({ token: 'tok' });
    expect(items).toEqual([]);
  });
});
