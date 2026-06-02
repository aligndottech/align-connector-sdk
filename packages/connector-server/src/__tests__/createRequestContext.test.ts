import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequestContext } from '../auth/createRequestContext.js';

describe('createRequestContext', () => {
  it('should create getCtx that returns stored context', async () => {
    const { middleware, getCtx } = createRequestContext();
    const app = express();
    app.use(middleware);
    app.get('/test', (_req, res) => {
      const ctx = getCtx();
      res.json({ bearer: ctx.bearer, hasReqId: !!ctx.reqId });
    });
    const res = await request(app).get('/test').set('Authorization', 'Bearer test-token');
    expect(res.body.bearer).toBe('test-token');
    expect(res.body.hasReqId).toBe(true);
  });

  it('should throw when getCtx called outside middleware', () => {
    const { getCtx } = createRequestContext();
    expect(() => getCtx()).toThrow('missing_request_context');
  });

  it('should support custom context fields via factory', async () => {
    const { middleware, getCtx } = createRequestContext({
      createContext: (req) => ({
        reqId: 'custom-req-id',
        bearer: req.get?.('Authorization')?.replace('Bearer ', ''),
        customField: 'custom-value',
      }),
    });
    const app = express();
    app.use(middleware);
    app.get('/test', (_req, res) => res.json({ custom: getCtx().customField }));
    const res = await request(app).get('/test');
    expect(res.body.custom).toBe('custom-value');
  });

  it('should support tryGetCtx that returns undefined outside context', () => {
    const { tryGetCtx } = createRequestContext();
    expect(tryGetCtx()).toBeUndefined();
  });

  it('should support runInContext for manual context injection', () => {
    const { runInContext, getCtx } = createRequestContext();
    const ctx = { reqId: 'manual-id', bearer: 'manual-bearer' };
    const result = runInContext(ctx, () => getCtx());
    expect(result.reqId).toBe('manual-id');
    expect(result.bearer).toBe('manual-bearer');
  });

  it('should isolate context between concurrent requests', async () => {
    const { middleware, getCtx } = createRequestContext();
    const app = express();
    app.use(middleware);
    app.get('/test', async (_req, res) => {
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      res.json({ bearer: getCtx().bearer });
    });

    const [res1, res2] = await Promise.all([
      request(app).get('/test').set('Authorization', 'Bearer token-1'),
      request(app).get('/test').set('Authorization', 'Bearer token-2'),
    ]);
    expect(res1.body.bearer).toBe('token-1');
    expect(res2.body.bearer).toBe('token-2');
  });
});
