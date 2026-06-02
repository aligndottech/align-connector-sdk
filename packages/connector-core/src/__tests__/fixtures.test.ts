import { describe, expect, it } from 'vitest';
import { fixtures } from '../testing/fixtures.js';

describe('fixtures', () => {
  it('should generate a decision with unique id', () => {
    const d1 = fixtures.decision();
    const d2 = fixtures.decision();
    expect(d1.id).toBeDefined();
    expect(d1.id).not.toBe(d2.id);
    expect(d1.title).toBeDefined();
  });

  it('should allow overriding decision fields', () => {
    const d = fixtures.decision({ title: 'Custom Title', status: 'archived' });
    expect(d.title).toBe('Custom Title');
    expect(d.status).toBe('archived');
  });

  it('should generate ingest response', () => {
    const r = fixtures.ingestResponse();
    expect(r.id).toBeDefined();
    expect(r.confidence).toBeTypeOf('number');
  });

  it('should generate batch ingest response', () => {
    const r = fixtures.ingestBatchResponse(3);
    expect(r.results).toHaveLength(3);
  });

  it('should generate webhook payload', () => {
    const p = fixtures.webhookPayload();
    expect(p.event_id).toBeDefined();
    expect(p.event_type).toBeDefined();
  });

  it('should generate tenant context', () => {
    const t = fixtures.tenantContext();
    expect(t.tenantId).toBeDefined();
    expect(t.bearer).toBeDefined();
  });

  it('should generate oauth credentials', () => {
    const c = fixtures.oauthCredentials('jira');
    expect(c.token).toContain('jira');
    expect(c.refresh_token).toBeDefined();
  });
});
