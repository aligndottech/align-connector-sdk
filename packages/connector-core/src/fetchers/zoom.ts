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

// Zoom's own per-page maximum for /users/me/recordings. Before ALI-828 this was
// the whole read: one page of 30, whatever the caller asked for.
const ZOOM_PAGE_MAX = 30;

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
 * Pages `/users/me/recordings` with `next_page_token` up to `limit`; a meeting
 * with no completed transcript, or one whose transcript will not download, is
 * counted into the report rather than dropped in silence.
 */
export class ZoomFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const limit = opts.limit ?? 30;
    const uuid = opts.uuid as string | undefined;
    const items: FetcherItem[] = [];
    let scanned = 0;
    let noTranscript = 0;
    let unreadable = 0;
    let pageToken: string | undefined;

    do {
      const path = uuid
        ? `/meetings/${encodeMeetingUuid(uuid)}/recordings`
        : `/users/me/recordings?page_size=${Math.min(limit - items.length, ZOOM_PAGE_MAX)}` +
          (pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : '');
      const data = await zoomGet<{ meetings?: ZoomMeeting[]; next_page_token?: string }>(path, opts.token);

      for (const meeting of data.meetings ?? []) {
        if (items.length >= limit) break;
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
      // The single-meeting path is one request by construction.
      pageToken = uuid ? undefined : data.next_page_token || undefined;
    } while (pageToken && items.length < limit);

    const skips: FetchSkip[] = [];
    if (noTranscript > 0) skips.push({ kind: 'shape', count: noTranscript, detail: 'meetings with no completed transcript' });
    if (unreadable > 0) skips.push({ kind: 'error', count: unreadable, detail: 'transcripts that could not be downloaded' });
    return { items, report: { platform: 'zoom', scanned, requested: limit, skips } };
  }
}
