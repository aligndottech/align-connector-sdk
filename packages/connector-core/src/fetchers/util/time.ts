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

/**
 * The one reader of a fetch window's `since`/`until`, shared by every windowed fetcher.
 * An absent or empty bound is no bound. A bound that is present and not a date is a
 * refusal, never a silent drop: a dropped bound reads a different window than the one
 * asked for (everything, or nothing) and the report would still say it was complete.
 */
export function parseWindow(since: string | undefined, until: string | undefined): ParsedWindow {
  const out: { sinceMs?: number; untilMs?: number; since?: string; until?: string } = {};
  for (const [name, raw] of [['since', since], ['until', until]] as const) {
    if (raw === undefined || raw === '') continue;
    const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    if (Number.isNaN(ms)) {
      return { ok: false, detail: `${name} is not a date (expected ISO-8601, such as 2026-03-01T00:00:00Z); nothing was read` };
    }
    out[`${name}Ms`] = ms;
    out[name] = new Date(ms).toISOString();
  }
  return { ok: true, ...out };
}
