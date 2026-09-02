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
