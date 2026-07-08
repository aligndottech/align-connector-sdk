import { describe, expect, it } from 'vitest';
import {
  DECISION_RELATIONSHIPS,
  DETERMINISTIC_TEMPERATURE,
  isDecisionRelationship,
} from '../index.js';
import type { DecisionRelationship } from '../index.js';

// ALI-219: the relationship-detection CONTRACT (the canonical type vocabulary +
// the determinism rule) has one source of truth here, so the gateway path and the
// align-cli local path can't drift apart again after ALI-213/218.

describe('relationship contract', () => {
  it('pins temperature 0 for reproducible relationship classification', () => {
    // A non-zero temperature makes classification stochastic - the same decision
    // pair would type differently each run. Both paths must pin this.
    expect(DETERMINISTIC_TEMPERATURE).toBe(0);
  });

  it('exposes the canonical relationship vocabulary as a runtime array', () => {
    // The bare `DecisionRelationship` type has no runtime value; consumers (the CLI
    // classifier prompt + parse validation) need the list at runtime.
    expect(DECISION_RELATIONSHIPS).toEqual([
      'supersedes',
      'conflicts_with',
      'contradicts',
      'duplicates',
      'clarifies',
      'relates',
      'refines',
      'supports',
      'questions',
      'blocks',
    ]);
  });

  it('accepts a canonical relationship type', () => {
    expect(isDecisionRelationship('supersedes')).toBe(true);
    expect(isDecisionRelationship('conflicts_with')).toBe(true);
  });

  it('rejects a non-canonical or non-string value', () => {
    // Guards against the divergence bug: the CLI invented depends_on/implements,
    // which the graph never accepts. The guard lets consumers coerce/drop them.
    expect(isDecisionRelationship('depends_on')).toBe(false);
    expect(isDecisionRelationship('relates_to')).toBe(false);
    expect(isDecisionRelationship('')).toBe(false);
    expect(isDecisionRelationship(123)).toBe(false);
    expect(isDecisionRelationship(null)).toBe(false);
  });

  it('narrows the type for a validated string', () => {
    const raw: unknown = 'refines';
    if (isDecisionRelationship(raw)) {
      const typed: DecisionRelationship = raw;
      expect(typed).toBe('refines');
    } else {
      throw new Error('expected refines to be a valid relationship');
    }
  });
});
