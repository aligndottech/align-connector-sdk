import { describe, expect, it } from 'vitest';
import {
  isSyntheticSource,
  navigableSourceUrl,
  SYNTHETIC_SOURCE_PREFIXES,
} from '../utils/syntheticSource.js';

/**
 * ALI-922. Promoted from align-stack's six independent copies (the gateway's minting site
 * plus five readers: mcp-align, the UI, mcp-teams, mcp-github, mcp-jira) into the shared
 * package every connector already depends on. See the docblock on syntheticSource.ts for
 * the full mechanism and why a synthetic `align://` identity is not a place anyone can open.
 *
 * This package cannot read align-stack's `suggestionHelpers.ts` (a different repo), so unlike
 * the connector-side parity tests this file pins the two namespaces directly rather than
 * reading the minting site. That is the trade this promotion makes: one shared implementation,
 * checked here by value rather than by cross-repo read.
 */
describe('syntheticSource (ALI-922)', () => {
  it('SYNTHETIC_SOURCE_PREFIXES is exactly the claimed and unsourced namespaces', () => {
    expect(SYNTHETIC_SOURCE_PREFIXES).toEqual(['align://claimed/', 'align://unsourced/']);
  });

  describe('isSyntheticSource', () => {
    it('a real source is not synthetic', () => {
      expect(isSyntheticSource('https://github.com/align/repo/pull/42')).toBe(false);
    });

    it('recognises the claimed namespace', () => {
      expect(isSyntheticSource('align://claimed/9f2c')).toBe(true);
    });

    it('recognises the unsourced namespace', () => {
      expect(isSyntheticSource('align://unsourced/9f2c')).toBe(true);
    });

    it('uses startsWith, not includes: a real page may carry the text in its path', () => {
      expect(isSyntheticSource('https://example.test/docs/align://claimed/x')).toBe(false);
    });

    it('is false for undefined, null and non-string values', () => {
      expect(isSyntheticSource(undefined)).toBe(false);
      expect(isSyntheticSource(null)).toBe(false);
    });
  });

  describe('navigableSourceUrl', () => {
    it('returns a real url unchanged', () => {
      expect(navigableSourceUrl('https://github.com/align/repo/pull/42')).toBe(
        'https://github.com/align/repo/pull/42'
      );
    });

    it('returns undefined for a synthetic url', () => {
      expect(navigableSourceUrl('align://claimed/9f2c')).toBeUndefined();
    });

    it('returns undefined for undefined, null and empty string', () => {
      expect(navigableSourceUrl(undefined)).toBeUndefined();
      expect(navigableSourceUrl(null)).toBeUndefined();
      expect(navigableSourceUrl('')).toBeUndefined();
    });
  });
});
