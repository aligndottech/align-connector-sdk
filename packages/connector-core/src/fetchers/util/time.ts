/**
 * Normalise a source timestamp to ISO-8601 Z, or undefined.
 *
 * Undefined rather than a fallback: a null date says "unknown", and a plausible
 * wrong date is indistinguishable from a measurement to everything downstream.
 * NaN is checked explicitly because every comparison against NaN is false in
 * both directions, so an unchecked bad date does not error, it silently vacates
 * whatever filter reads it later.
 *
 * One writer for the normalisation, so ten fetchers cannot disagree about what
 * "ISO" means. Accepts epoch milliseconds as a number for sources that hand out
 * a numeric timestamp (Slack's `ts` is epoch seconds; callers multiply).
 */
export function toIsoOrUndefined(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  // A zero or negative instant is not a source date either: Number('') is 0, and
  // an epoch stamp in a decision graph is a fabrication with a plausible face.
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

export type ParsedWindow =
  | { ok: true; sinceMs?: number; untilMs?: number; since?: string; until?: string }
  | { ok: false; detail: string };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY = 86_400_000;

/** Strict ISO-8601 to ms, or NaN. Date.parse alone accepts '0', 'foo 1', '2026-02-30'
 *  (rolled to March) and a zoneless datetime in the host's timezone; none is a window. */
function strictIsoMs(raw: string): number {
  const d = DATE_ONLY.exec(raw);
  const t = d ? undefined : DATE_TIME.exec(raw);
  const m = d ?? t;
  if (!m) return Number.NaN;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 2100) return Number.NaN;
  const cal = new Date(Date.UTC(y, mo - 1, da));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== da) return Number.NaN;
  if (t) {
    const [h, mi, sec] = [Number(t[4]), Number(t[5]), Number(t[6] ?? 0)];
    const off = /^[+-](\d{2}):(\d{2})$/.exec(t[7]!);
    if (h > 23 || mi > 59 || sec > 59 || (off && (Number(off[1]) > 23 || Number(off[2]) > 59))) return Number.NaN;
  }
  return Date.parse(raw);
}

/**
 * The one reader of a fetch window's `since`/`until`, shared by every windowed fetcher.
 * An absent or empty bound is no bound. A bound that is present and not a strict ISO-8601
 * date is a refusal, never a silent drop: a dropped bound reads a different window than
 * the one asked for (everything, or nothing) and the report would still say it was
 * complete. Accepted: `YYYY-MM-DD` (a real calendar day, read as UTC) or a datetime with a
 * REQUIRED zone (`Z` or `+hh:mm`), years 1970 to 2100. Also refused: `until` not after
 * `since`, and a `since` more than a day ahead of now (nothing can have changed yet).
 */
export function parseWindow(since: string | undefined, until: string | undefined): ParsedWindow {
  const out: { sinceMs?: number; untilMs?: number; since?: string; until?: string } = {};
  for (const [name, raw] of [['since', since], ['until', until]] as const) {
    if (raw === undefined || raw === '') continue;
    const ms = typeof raw === 'string' ? strictIsoMs(raw) : Number.NaN;
    if (Number.isNaN(ms)) {
      return { ok: false, detail: `${name} is not a date (expected ISO-8601, such as 2026-03-01 or 2026-03-01T00:00:00Z); nothing was read` };
    }
    out[`${name}Ms`] = ms;
    out[name] = new Date(ms).toISOString();
  }
  if (out.sinceMs !== undefined && out.untilMs !== undefined && out.untilMs <= out.sinceMs) {
    return { ok: false, detail: 'until is not after since, so the window is empty; nothing was read' };
  }
  if (out.sinceMs !== undefined && out.sinceMs > Date.now() + DAY) {
    return { ok: false, detail: 'since is in the future, so there is nothing to read yet; nothing was read' };
  }
  return { ok: true, ...out };
}
