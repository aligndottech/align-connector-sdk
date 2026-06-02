import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { SlackFetcher } from '../fetchers/slack.js';
import { TeamsFetcher } from '../fetchers/teams.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Awaited<ReturnType<typeof fetch>>;
const bad = (body: unknown, status = 403) =>
  ({ ok: false, status, json: async () => body }) as unknown as Awaited<ReturnType<typeof fetch>>;

describe('SlackFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('captures threads (>=2 replies) with author = thread starter', async () => {
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.includes('auth.test')) return Promise.resolve(ok({ ok: true }));
      if (url.includes('conversations.list')) return Promise.resolve(ok({ ok: true, channels: [{ id: 'C1', name: 'eng' }] }));
      if (url.includes('conversations.history'))
        return Promise.resolve(ok({ ok: true, messages: [{ ts: '111.222', text: 'decide?', reply_count: 3, user: 'U1' }] }));
      if (url.includes('conversations.replies'))
        return Promise.resolve(ok({ ok: true, messages: [{ ts: '111.222', text: 'we decided X', user: 'U1' }] }));
      if (url.includes('users.info'))
        return Promise.resolve(ok({ ok: true, user: { name: 'ada', real_name: 'Ada L', profile: { email: 'ada@x.io' } } }));
      return Promise.resolve(ok({ ok: true }));
    }));

    const items = await new SlackFetcher().fetch({ token: 'tok', interChannelDelayMs: 0 });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source_url: 'https://slack.com/archives/C1/p111222',
      platform: 'slack',
      author: { name: 'Ada L', handle: 'ada', email: 'ada@x.io' },
    });
    expect(items[0].raw_text).toContain('[#eng] Thread:');
  });

  it('throws when the Slack API returns ok:false', async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: false, error: 'invalid_auth' }));
    await expect(new SlackFetcher().fetch({ token: 'bad', interChannelDelayMs: 0 })).rejects.toThrow(/invalid_auth/);
  });
});

describe('TeamsFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('captures channel messages with author = sender, stripping html', async () => {
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/me/joinedTeams')) return Promise.resolve(ok({ value: [{ id: 'T1', displayName: 'Platform' }] }));
      if (url.endsWith('/teams/T1/channels')) return Promise.resolve(ok({ value: [{ id: 'CH1', displayName: 'General' }] }));
      if (url.includes('/messages'))
        return Promise.resolve(
          ok({
            value: [
              {
                id: 'm1',
                subject: 'DB choice',
                webUrl: 'https://teams.microsoft.com/m1',
                body: { content: '<p>use postgres</p>', contentType: 'html' },
                from: { user: { displayName: 'Linus' } },
                replies: [],
              },
            ],
          }),
        );
      return Promise.resolve(ok({ value: [] }));
    }));

    const items = await new TeamsFetcher().fetch({ token: 'tok' });

    expect(items[0]).toMatchObject({
      source_url: 'https://teams.microsoft.com/m1',
      platform: 'teams',
      title: 'DB choice',
      author: { name: 'Linus' },
    });
    expect(items[0].raw_text).toContain('use postgres');
    expect(items[0].raw_text).not.toContain('<p>');
  });

  it('gives a helpful error when admin consent is missing', async () => {
    mockFetch.mockResolvedValueOnce(bad({ error: { code: 'Authorization_RequestDenied' } }, 403));
    await expect(new TeamsFetcher().fetch({ token: 't' })).rejects.toThrow(/admin consent/);
  });
});
