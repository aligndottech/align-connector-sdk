import { describe, expect, it } from 'vitest';
import { CONNECTOR_TIERS, getTierCapabilities, TIER_CAPABILITIES } from '../tiers/capabilities.js';

describe('connector tiers', () => {
  it('should define all 7 tiers', () => {
    expect(CONNECTOR_TIERS).toHaveLength(7);
    expect(CONNECTOR_TIERS).toEqual([
      'communication',
      'project_management',
      'code',
      'documentation',
      'cicd',
      'observability',
      'intelligence',
    ]);
  });

  it('should define capabilities for every tier', () => {
    for (const tier of CONNECTOR_TIERS) {
      const caps = TIER_CAPABILITIES[tier];
      expect(caps).toBeDefined();
      expect(caps.tier).toBe(tier);
      expect(typeof caps.supportsWebhooks).toBe('boolean');
      expect(typeof caps.supportsReadOnlyTools).toBe('boolean');
    }
  });

  it('should give communication tier full capabilities', () => {
    const comm = getTierCapabilities('communication');
    expect(comm.supportsWebhooks).toBe(true);
    expect(comm.supportsTranscripts).toBe(true);
    expect(comm.supportsMultiDecision).toBe(true);
    expect(comm.supportsIssueCreation).toBe(true);
    expect(comm.supportsHistoricalImport).toBe(true);
    expect(comm.supportsDecisionComments).toBe(true);
    expect(comm.supportsInteractiveCommands).toBe(true);
  });

  it('should limit observability tier to read-only tools', () => {
    const obs = getTierCapabilities('observability');
    expect(obs.supportsWebhooks).toBe(false);
    expect(obs.supportsTranscripts).toBe(false);
    expect(obs.supportsHistoricalImport).toBe(false);
    expect(obs.supportsReadOnlyTools).toBe(true);
  });

  it('should give documentation tier webhook + historical support', () => {
    const doc = getTierCapabilities('documentation');
    expect(doc.supportsWebhooks).toBe(true);
    expect(doc.supportsHistoricalImport).toBe(true);
    expect(doc.supportsTranscripts).toBe(false);
    expect(doc.supportsDecisionComments).toBe(true);
  });

  it('should give cicd tier historical import but no webhooks', () => {
    const cicd = getTierCapabilities('cicd');
    expect(cicd.supportsWebhooks).toBe(false);
    expect(cicd.supportsHistoricalImport).toBe(true);
    expect(cicd.supportsInteractiveCommands).toBe(false);
  });

  it('should give intelligence tier only read-only tools', () => {
    const intel = getTierCapabilities('intelligence');
    expect(intel.supportsWebhooks).toBe(false);
    expect(intel.supportsHistoricalImport).toBe(false);
    expect(intel.supportsDecisionComments).toBe(false);
    expect(intel.supportsReadOnlyTools).toBe(true);
  });

  it('should ensure all tiers support read-only tools', () => {
    for (const tier of CONNECTOR_TIERS) {
      expect(getTierCapabilities(tier).supportsReadOnlyTools).toBe(true);
    }
  });

  it('communication tier has supportsProactiveNotifications = true', () => {
    const caps = getTierCapabilities('communication');
    expect(caps.supportsProactiveNotifications).toBe(true);
  });

  it('non-communication tiers have supportsProactiveNotifications = false', () => {
    const nonCommTiers = CONNECTOR_TIERS.filter((t) => t !== 'communication');
    for (const tier of nonCommTiers) {
      expect(getTierCapabilities(tier).supportsProactiveNotifications).toBe(false);
    }
  });
});
