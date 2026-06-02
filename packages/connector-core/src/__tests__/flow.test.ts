import { describe, expect, it } from 'vitest';
import { NoOpDecisionFlowStateRepository } from '../types/flow.js';

describe('NoOpDecisionFlowStateRepository', () => {
  it('saves nothing, reads back null, and deletes without error', async () => {
    const repo = new NoOpDecisionFlowStateRepository();
    await expect(
      repo.saveAlertState({
        tenantId: 't1',
        messageId: 'm1',
        currentDecisionId: 'd1',
        state: {
          action: 'awaiting_conflict_action',
          currentDecisionId: 'd1',
          relatedDecisionId: 'd2',
          relationship: 'conflicts_with',
        },
        expiresAt: new Date(0),
      }),
    ).resolves.toBeUndefined();
    await expect(repo.getAlertState({ tenantId: 't1', messageId: 'm1' })).resolves.toBeNull();
    await expect(repo.deleteAlertState({ tenantId: 't1', messageId: 'm1' })).resolves.toBeUndefined();
  });
});
