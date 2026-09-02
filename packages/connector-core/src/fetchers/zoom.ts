import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult, FetchSkip } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';

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

// Zoom lists recordings for a from/to window at most a month wide, and with
// neither parameter it lists only the current day. So a read walks windows back
// through `daysBack`, newest first; a boundary day can appear in two windows,
// which is what the uuid dedupe below is for.
const ZOOM_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Day windows covering the last `daysBack` days, newest first. */
function recordingWindows(now: number, daysBack: number): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  let to = Math.floor(now / DAY_MS) * DAY_MS;
  const oldest = to - daysBack * DAY_MS;
  while (to > oldest) {
    const from = Math.max(to - (ZOOM_WINDOW_DAYS - 1) * DAY_MS, oldest);
    windows.push({ from: isoDay(from), to: isoDay(to) });
    to = from - DAY_MS;
  }
  return windows;
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
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Zoom API error ${res.status}: ${err.message ?? 'unknown'}`);
  }
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
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const limit = opts.limit ?? 30;
    const daysBack = (opts.daysBack as number | undefined) ?? 90;
    const uuid = opts.uuid as string | undefined;
    const pageSize = Math.min(limit, ZOOM_PAGE_MAX);
    const items: FetcherItem[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let noTranscript = 0;
    let unreadable = 0;

    // The single-meeting path has no window and is one request by construction.
    const windows: Array<{ from: string; to: string } | undefined> = uuid ? [undefined] : recordingWindows(Date.now(), daysBack);
    for (const window of windows) {
      if (items.length >= limit) break;
      let pageToken: string | undefined;
      do {
      const path = uuid
        ? `/meetings/${encodeMeetingUuid(uuid)}/recordings`
        : `/users/me/recordings?page_size=${pageSize}&from=${window!.from}&to=${window!.to}` +
          (pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : '');
      const data = await zoomGet<{ meetings?: ZoomMeeting[]; next_page_token?: string }>(path, opts.token);

      for (const meeting of data.meetings ?? []) {
        if (items.length >= limit) break;
        if (seen.has(meeting.uuid)) continue;
        seen.add(meeting.uuid);
        scanned += 1;
        const vttFile = (meeting.recording_files ?? []).find(
          (f) => f.file_type === 'TRANSCRIPT' && f.status === 'completed',
        );
        if (!vttFile) {
          noTranscript += 1;
          continue;
        }

        try {
          const vttRes = await fetch(`${vttFile.download_url}?access_token=${opts.token}`);
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
          items.push({
            source_url: `https://zoom.us/recording/${encodeMeetingUuid(meeting.uuid)}`,
            platform: 'zoom',
            raw_text: `[${meeting.topic} - ${date}]\n${transcript}`.slice(0, 4000),
            title: `${meeting.topic} (${date})`.slice(0, 80),
            ...(createdAt ? { created_at: createdAt } : {}),
            ...(host ? { author: host } : {}),
          });
        } catch {
          unreadable += 1;
        }
      }
      pageToken = uuid ? undefined : data.next_page_token || undefined;
      } while (pageToken && items.length < limit);
    }

    const skips: FetchSkip[] = [];
    if (noTranscript > 0) skips.push({ kind: 'shape', count: noTranscript, detail: 'meetings with no completed transcript' });
    if (unreadable > 0) skips.push({ kind: 'error', count: unreadable, detail: 'transcripts that could not be downloaded' });
    return { items, report: { platform: 'zoom', scanned, requested: limit, skips } };
  }
}
