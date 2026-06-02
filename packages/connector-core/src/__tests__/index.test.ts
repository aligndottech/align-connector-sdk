import { describe, expect, it } from 'vitest';

describe('@aligndottech/connector-core exports', () => {
  it('exports the gateway client and tiers', async () => {
    const core = await import('../index.js');
    expect(core.GatewayClient).toBeDefined();
    expect(typeof core.GatewayClient).toBe('function');
    expect(core.CONNECTOR_TIERS).toContain('communication');
    expect(core.MockGatewayClient).toBeDefined();
    expect(core.fixtures).toBeDefined();
  });

  it('exports the flow no-op repository', async () => {
    const core = await import('../index.js');
    expect(core.NoOpDecisionFlowStateRepository).toBeDefined();
  });

  // IP boundary: the open core must NOT ship the decision-capture engines
  // or the decision-graph intelligence methods. Those stay closed.
  it('does NOT export the proprietary engines', async () => {
    const core = (await import('../index.js')) as Record<string, unknown>;
    expect(core.UnifiedConnectorFlow).toBeUndefined();
    expect(core.DecisionOperationsService).toBeUndefined();
  });

  it('does NOT expose decision-graph intelligence methods on GatewayClient', async () => {
    const { GatewayClient } = await import('../index.js');
    const proto = GatewayClient.prototype as Record<string, unknown>;
    for (const closed of [
      'mergeDecisions',
      'mergeMultipleDecisions',
      'resolveConflict',
      'resolveConflicts',
      'acceptSupersession',
      'rejectSupersession',
      'extractMultipleDecisions',
      'saveExtractedDecision',
      'analyzeConversation',
    ]) {
      expect(proto[closed], `${closed} must stay closed`).toBeUndefined();
    }
  });

  it('keeps the capture + read surface open', async () => {
    const { GatewayClient } = await import('../index.js');
    const proto = GatewayClient.prototype as Record<string, unknown>;
    for (const open of ['ingest', 'consensus', 'conversational', 'getDecision', 'searchDecisions', 'getSnapshot']) {
      expect(typeof proto[open], `${open} must stay open`).toBe('function');
    }
  });
});
