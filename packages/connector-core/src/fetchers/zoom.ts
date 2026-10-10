import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult, FetchSkip, FetchOneResult } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { providerError } from './errors.js';
import { buildFetchReport, refusedRead } from './util/report.js';
import { budgetSpent } from './util/since.js';
import { parseWindow } from './util/time.js';
import { normaliseSourceKey } from '../sourceKey.js';
import { parseUrl, vendorUrl } from './util/single.js';

/** Redirect hops a transcript download may follow after the first request. */
const ZOOM_MAX_DOWNLOAD_HOPS = 2;

/** A download that redirected somewhere unsafe, or too many times. Counted, never thrown out. */
class UnsafeRedirectError extends Error {
  constructor() {
    super('transcript download redirected off zoom.us or too many times');
    this.name = 'UnsafeRedirectError';
  }
}

/**
 * Download a transcript, following Zoom's redirect by hand.
 *
 * UNVERIFIED LIVE: that Zoom answers a recording download with a 302 to a signed file
 * host (ssrweb.zoom.us and similar) comes from Zoom developer-forum reports, not from a
 * read against a real account (none was available). Check one real recording.
 *
 * Every hop is held to the vendor rules (https, zoom.us or *.zoom.us, no userinfo or
 * port), at most {@link ZOOM_MAX_DOWNLOAD_HOPS} hops, redirect: manual throughout. The
 * Bearer goes only to the first host and same-host hops: a hop to a different host is
 * fetched WITHOUT it (a signed file URL carries its own authority).
 */
async function downloadTranscript(first: URL, token: string): Promise<Awaited<ReturnType<typeof fetch>>> {
  let url = first;
  let sendAuth = true;
  for (let hop = 0; ; hop++) {
    const res = await fetch(url.href, { headers: sendAuth ? { Authorization: `Bearer ${token}` } : {}, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;
    if (hop >= ZOOM_MAX_DOWNLOAD_HOPS) throw new UnsafeRedirectError();
    const location = res.headers?.get?.('location');
    let resolved: string | undefined;
    try {
      resolved = location ? new URL(location, url).href : undefined;
    } catch {
      resolved = undefined;
    }
    const next = resolved ? zoomDownloadUrl(resolved) : undefined;
    if (!next) throw new UnsafeRedirectError();
    if (next.hostname.toLowerCase() !== url.hostname.toLowerCase()) sendAuth = false;
    url = next;
  }
}

/** A transcript download URL: https on zoom.us or a *.zoom.us host, else undefined. */
function zoomDownloadUrl(raw: string): URL | undefined {
  const host = parseUrl(raw)?.hostname.toLowerCase();
  if (!host || (host !== 'zoom.us' && !host.endsWith('.zoom.us'))) return undefined;
  return vendorUrl(raw, [host]);
}

interface ZoomRecordingFile {
  file_type: string;
  download_url: string;
  status: string;
}

interface ZoomMeeting {
  id: string | number;
  uuid: string;
  topic: string;
  start_time: string;
  host_email?: string;
  recording_files?: ZoomRecordingFile[];
}

// Zoom's documented page_size maximum for /users/me/recordings. 30 is the default,
// and before ALI-828 it was the whole read: one page of 30, whatever the caller
// asked for. Held constant across next_page_token requests, as Zoom requires.
const ZOOM_PAGE_MAX = 300;

// TIMEZONE UNVERIFIED: from/to are calendar dates (yyyy-mm-dd) and this code computes them
// in UTC. Zoom's docs do not say which timezone it applies to them (the account's, the
// user's, or UTC), and no live read has checked it. Until one does, a meeting near
// midnight at the edge of a window may fall into the neighbouring window or outside the
// read; the uuid dedupe and the exact since/until start-time checks below bound the
// damage to the edge day.
//
// Zoom lists recordings for a from/to window at most a month wide, and with
// neither parameter it lists only the current day. So a read walks windows back
// through `daysBack`, newest first; a boundary day can appear in two windows,
// which is what the uuid dedupe below is for.
const ZOOM_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Day windows from the day `oldestDay` (inclusive, a UTC day start) to today, newest first. */
function windowsFrom(now: number, oldestDay: number): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  let to = Math.floor(now / DAY_MS) * DAY_MS;
  while (to >= oldestDay) {
    const from = Math.max(to - (ZOOM_WINDOW_DAYS - 1) * DAY_MS, oldestDay);
    windows.push({ from: isoDay(from), to: isoDay(to) });
    to = from - DAY_MS;
  }
  return windows;
}

/** Day windows covering the last `daysBack` days, newest first. */
function recordingWindows(now: number, daysBack: number): Array<{ from: string; to: string }> {
  return windowsFrom(now, Math.floor(now / DAY_MS) * DAY_MS - (daysBack - 1) * DAY_MS);
}

function parseWebVtt(vtt: string): string {
  return vtt
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== '' &&
        line.trim() !== 'WEBVTT' &&
        !/^\d+$/.test(line.trim()) &&
        !line.includes(' --> '),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeMeetingUuid(uuid: string): string {
  const encoded = encodeURIComponent(uuid);
  return uuid.includes('//') ? encodeURIComponent(encoded) : encoded;
}

async function zoomGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.zoom.us/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual', // a 3xx is a failed call, never a hop carrying the token
  });
  if (!res.ok) throw await providerError('Zoom', res);
  return res.json() as Promise<T>;
}

/**
 * Read-only personal Zoom fetcher: cloud-recording transcripts (VTT), parsed to
 * plain text. Author = the meeting host. `uuid` (single meeting) rides on opts.
 * Lists `/users/me/recordings` in 30-day windows back through `daysBack`
 * (default 90), paging each with `next_page_token` up to `limit`; a meeting
 * with no completed transcript, or one whose transcript will not download, is
 * counted into the report rather than dropped in silence.
 */
export class ZoomFetcher implements ConnectorFetcher {
  /**
   * Not supported: a recording or share link does not name a transcript the user's own
   * token can fetch on its own, so every URL is a `shape` skip and no request is made.
   */
  async fetchOne(url: string): Promise<FetchOneResult> {
    // Origin only: a share or play link carries its access token in the PATH
    // (/rec/share/<token>) and a passcode in the query (?pwd=), so neither is echoed.
    const origin = parseUrl(url)?.origin;
    return { skip: { kind: 'shape', count: 1, detail: `Zoom links are not supported for single capture${origin ? `: ${origin}` : ''}` } };
  }

  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const limit = opts.limit ?? 30;
    const daysBack = (opts.daysBack as number | undefined) ?? 90;
    const uuid = opts.uuid as string | undefined;
    // `since` maps to 30-day from/to windows reaching back to the since DAY (Zoom's
    // from/to are dates); a meeting earlier that day is then dropped by its start time.
    const win = parseWindow(opts.since as string | undefined, opts.until as string | undefined);
    if (!win.ok) return refusedRead({ platform: 'zoom', requested: limit, scope: 'yours', detail: win.detail });
    const since = win.sinceMs;
    const until = win.untilMs;
    const startedAt = Date.now();
    // The newest day to list: the until day when given, else today.
    const endMs = until ?? startedAt;
    let windowsOutOfTime = 0;
    const pageSize = Math.min(limit, ZOOM_PAGE_MAX);
    const items: FetcherItem[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let noTranscript = 0;
    let transcriptPending = 0;
    let unreadable = 0;
    let offHostDownloads = 0;
    let badRedirects = 0;
    // The item limit leaving a window, a page or a meeting unread.
    let cutByLimit = false;

    // The single-meeting path has no window and is one request by construction.
    const windows: Array<{ from: string; to: string } | undefined> = uuid
      ? [undefined]
      : since !== undefined
        ? windowsFrom(endMs, Math.floor(since / DAY_MS) * DAY_MS)
        : recordingWindows(endMs, daysBack);
    for (let wi = 0; wi < windows.length; wi++) {
      const window = windows[wi];
      if (items.length >= limit) {
        cutByLimit = true;
        break;
      }
      if (wi > 0 && budgetSpent(startedAt, opts.timeBudgetMs)) {
        windowsOutOfTime = windows.length - wi;
        break;
      }
      let pageToken: string | undefined;
      do {
      const path = uuid
        ? `/meetings/${encodeMeetingUuid(uuid)}/recordings`
        : `/users/me/recordings?page_size=${pageSize}&from=${window!.from}&to=${window!.to}` +
          (pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : '');
      const data = await zoomGet<{ meetings?: ZoomMeeting[]; next_page_token?: string } & Partial<ZoomMeeting>>(path, opts.token);
      // The single-meeting endpoint answers with the meeting itself, recording_files at the
      // top level and no meetings array. Reading meetings[] there returned nothing, always.
      const meetings = data.meetings ?? (data.recording_files ? [data as ZoomMeeting] : []);

      for (const meeting of meetings) {
        if (items.length >= limit) {
          cutByLimit = true;
          break;
        }
        if (seen.has(meeting.uuid)) continue;
        seen.add(meeting.uuid);
        const startMs = Date.parse(meeting.start_time);
        if (since !== undefined && !Number.isNaN(startMs) && startMs < since) continue; // the since day, before since
        if (until !== undefined && !Number.isNaN(startMs) && startMs >= until) continue; // the until day, at or after until
        scanned += 1;
        const transcripts = (meeting.recording_files ?? []).filter((f) => f.file_type === 'TRANSCRIPT');
        const vttFile = transcripts.find((f) => f.status === 'completed');
        if (!vttFile) {
          // A transcript file that is not completed yet (processing) will exist on a later
          // read, so it is unread, not set aside; only a meeting with no transcript is shape.
          if (transcripts.length > 0) transcriptPending += 1;
          else noTranscript += 1;
          continue;
        }

        // The download URL comes from the response, so it is held to the vendor rules
        // (https, a zoom.us host, no userinfo or port) before the token is sent, and the
        // token travels in a header, never the query. Redirects are followed by hand,
        // bounded, and the token does not cross to another host (downloadTranscript).
        const downloadUrl = zoomDownloadUrl(vttFile.download_url);
        if (!downloadUrl) {
          offHostDownloads += 1;
          continue;
        }
        try {
          let vttRes: Awaited<ReturnType<typeof fetch>>;
          try {
            vttRes = await downloadTranscript(downloadUrl, opts.token);
          } catch (e) {
            if (e instanceof UnsafeRedirectError) {
              badRedirects += 1;
              continue;
            }
            throw e;
          }
          if (!vttRes.ok) {
            unreadable += 1;
            continue;
          }
          const vttText = await vttRes.text();
          const transcript = parseWebVtt(vttText);
          if (!transcript) {
            noTranscript += 1;
            continue;
          }

          const date = meeting.start_time.slice(0, 10);
          const createdAt = toIsoOrUndefined(meeting.start_time);
          const host = meeting.host_email
            ? { name: meeting.host_email.split('@')[0], email: meeting.host_email }
            : undefined;
          const sourceUrl = `https://zoom.us/recording/${encodeMeetingUuid(meeting.uuid)}`;
          const sourceKey = normaliseSourceKey('zoom', sourceUrl);
          items.push({
            source_url: sourceUrl,
            platform: 'zoom',
            raw_text: `[${meeting.topic} - ${date}]\n${transcript}`.slice(0, 4000),
            title: `${meeting.topic} (${date})`.slice(0, 80),
            ...(createdAt ? { created_at: createdAt } : {}),
            // A recorded meeting does not change after it ends, and the windows are cut by
            // start date, so the start time is both its date and where a resume begins.
            ...(createdAt ? { updated_at: createdAt } : {}),
            ...(sourceKey ? { source_key: sourceKey } : {}),
            ...(host ? { author: host } : {}),
          });
        } catch {
          unreadable += 1;
        }
      }
      pageToken = uuid ? undefined : data.next_page_token || undefined;
      } while (pageToken && items.length < limit);
      if (pageToken) cutByLimit = true;
    }

    const skips: FetchSkip[] = [];
    if (noTranscript > 0) skips.push({ kind: 'shape', count: noTranscript, detail: 'meetings with no transcript' });
    if (transcriptPending > 0) {
      skips.push({ kind: 'pending', count: transcriptPending, detail: 'meetings whose transcript is not ready yet (Zoom is still processing it)' });
    }
    if (unreadable > 0) skips.push({ kind: 'error', count: unreadable, detail: 'transcripts that could not be downloaded' });
    if (offHostDownloads > 0) {
      skips.push({ kind: 'error', count: offHostDownloads, detail: 'transcripts whose download URL is not on zoom.us (not fetched)' });
    }
    if (badRedirects > 0) {
      skips.push({ kind: 'error', count: badRedirects, detail: `transcripts whose download redirected off zoom.us, without a location, or more than ${ZOOM_MAX_DOWNLOAD_HOPS} times (not followed)` });
    }
    if (windowsOutOfTime > 0) {
      skips.push({ kind: 'time_budget', count: windowsOutOfTime, detail: `30-day windows not read (the ${opts.timeBudgetMs} ms time budget ran out)` });
    }
    return {
      items,
      report: buildFetchReport(items, { platform: 'zoom', scanned, requested: limit, skips, scope: 'yours', untilMs: win.untilMs, exhausted: !cutByLimit && windowsOutOfTime === 0 }),
    };
  }
}
