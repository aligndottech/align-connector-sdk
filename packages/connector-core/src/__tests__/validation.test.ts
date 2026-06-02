import { describe, expect, it } from 'vitest';
import { UUID_REGEX, isValidUUID, assertValidUUID } from '../utils/validation.js';

describe('validation', () => {
  const valid = '123e4567-e89b-12d3-a456-426614174000';

  it('accepts a well-formed UUID', () => {
    expect(isValidUUID(valid)).toBe(true);
    expect(UUID_REGEX.test(valid)).toBe(true);
  });

  it('rejects malformed UUIDs', () => {
    for (const bad of ['', 'not-a-uuid', '123e4567e89b12d3a456426614174000', `${valid}-extra`]) {
      expect(isValidUUID(bad)).toBe(false);
    }
  });

  it('assertValidUUID throws with the field name on invalid input', () => {
    expect(() => assertValidUUID('nope', 'decisionId')).toThrowError(/decisionId/);
  });

  it('assertValidUUID is a no-op for valid input', () => {
    expect(() => assertValidUUID(valid)).not.toThrow();
  });
});
