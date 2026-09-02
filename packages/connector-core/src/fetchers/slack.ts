import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem } from '../types/fetcher.js';

async function slackGet(
  endpoint: string,
  token: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) throw new Error(`Slack API error on ${endpoint}: ${data.error as string}`);
  return data;
}

interface SlackMessage {
  ts: string;
  text?: string;
  reply_count?: number;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackChannel {
  id: string;
  name: string;
}

/**
 * Message subtypes that are the WORKSPACE talking, not a person: joins, leaves,
 * topic changes, pins, and app output. A thread made only of these is machinery,
 * and on the Align demo workspace 35 of 39 captured "threads" were exactly that -
 * a tombstone root under the Align app's own replies (ALI-828).
 *
 * A closed denylist rather than "any subtype at all": `thread_broadcast` is a
 * human reply that was also posted to the channel, and `file_share` is a human
 * sharing a file with a comment. Both are decision content and both carry a
 * subtype. Every member here has its own case in fetchers.slack.test.ts.
 */
const SYSTEM_SUBTYPES = new Set([
  'bot_message',
  'tombstone',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'pinned_item',
  'bot_add',
  'bot_remove',
  'reminder_add',
]);

/**
 * A message a person wrote. `bot_id` catches an app posting AS a user (which
 * carries no subtype at all), and a message with no `user` has nobody to
 * attribute it to.
 *
 * Deliberately not "is this the Align bot": the CLI's Slack path uses a user
 * token, whose `auth.test` names the HUMAN, so an identity filter would delete
 * the user's own messages. The shape test catches Align's bot as one member of
 * the class of all bots, and stays vendor-neutral.
 */
function isHumanMessage(m: SlackMessage): boolean {
  if (m.bot_id) return false;
  if (m.subtype && SYSTEM_SUBTYPES.has(m.subtype)) return false;
  return Boolean(m.user);
}

/** Resolve a Slack user id to a display name (cached - one users.info call per unique user). */
function makeUserResolver(token: string) {
  const cache = new Map<string, { name: string; handle?: string; email?: string } | null>();
  return async (userId: string | undefined): Promise<{ name: string; handle?: string; email?: string } | undefined> => {
    if (!userId) return undefined;
    if (cache.has(userId)) return cache.get(userId) ?? undefined;
    try {
      const data = await slackGet('users.info', token, { user: userId });
      const u = (data.user ?? {}) as {
        name?: string;
        real_name?: string;
        profile?: { real_name?: string; display_name?: string; email?: string };
      };
      const name = u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || userId;
      const resolved = {
        name,
        ...(u.name ? { handle: u.name } : {}),
        ...(u.profile?.email ? { email: u.profile.email } : {}),
      };
      cache.set(userId, resolved);
      return resolved;
    } catch {
      cache.set(userId, null); // don't retry a failed lookup
      return undefined;
    }
  };
}

/**
 * Read-only personal Slack fetcher: threaded conversations (>=2 replies) the
 * token can see, within `daysBack`, that hold at least one HUMAN message. Title
 * and author come from the first human message, so a thread whose root was
 * deleted or posted by a bot is still captured when a person spoke in it, and a
 * thread made only of bot and system output is not captured at all. A delay
 * between channels keeps under Slack's Tier-2 rate limit (override via
 * `interChannelDelayMs`).
 */
export class SlackFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    const limit = opts.limit ?? 50;
    const daysBack = (opts.daysBack as number | undefined) ?? 90;
    const delayMs = (opts.interChannelDelayMs as number | undefined) ?? 3000;
    const oldest = String(Math.floor(Date.now() / 1000) - daysBack * 86400);

    await slackGet('auth.test', opts.token);

    const chanData = await slackGet('conversations.list', opts.token, {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '100',
    });
    const channels = (chanData.channels as SlackChannel[]) ?? [];

    const resolveUser = makeUserResolver(opts.token);
    const items: FetcherItem[] = [];

    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const channel = channels[channelIndex];
      if (items.length >= limit) break;
      try {
        if (channelIndex > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const hist = await slackGet('conversations.history', opts.token, {
          channel: channel.id,
          oldest,
          limit: '100',
        });
        const messages = (hist.messages as SlackMessage[]) ?? [];
        const threads = messages.filter((m) => (m.reply_count ?? 0) >= 2);

        for (const thread of threads) {
          if (items.length >= limit) break;
          try {
            const replies = await slackGet('conversations.replies', opts.token, {
              channel: channel.id,
              ts: thread.ts,
            });
            const allMsgs = (replies.messages as SlackMessage[]) ?? [];
            // The thread's identity comes from the first HUMAN message: a deleted or
            // bot root has no title and nobody to attribute, but the conversation
            // under it may be entirely real.
            const firstHuman = allMsgs.find(isHumanMessage);
            if (!firstHuman) continue; // machinery, not a conversation

            // Every fetched message, bot replies included: a bot reply inside a human
            // thread is often the CI output being discussed.
            const text = allMsgs.map((m) => m.text ?? '').join('\n');
            const author = await resolveUser(firstHuman.user);
            items.push({
              source_url: `https://slack.com/archives/${channel.id}/p${thread.ts.replace('.', '')}`,
              platform: 'slack',
              raw_text: `[#${channel.name}] Thread:\n${text}`,
              title: (firstHuman.text ?? `Thread in #${channel.name}`).slice(0, 80),
              ...(author ? { author } : {}),
            });
          } catch {
            /* skip individual thread errors */
          }
        }
      } catch {
        /* skip channels that are inaccessible */
      }
    }

    return items;
  }
}
