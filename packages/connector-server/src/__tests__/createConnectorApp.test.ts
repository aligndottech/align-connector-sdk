import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createConnectorApp } from '../server/createConnectorApp.js';

describe('createConnectorApp', () => {
  it('should create an Express app with health endpoint', async () => {
    const app = createConnectorApp({ name: 'test-connector', version: '1.0.0' });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'test-connector', version: '1.0.0' });
  });

  it('should include helmet security headers', async () => {
    const app = createConnectorApp({ name: 'test', version: '1.0.0' });
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should include CORS headers', async () => {
    const app = createConnectorApp({ name: 'test', version: '1.0.0' });
    const res = await request(app).get('/health').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });

  it('should parse JSON body up to 512kb', async () => {
    const app = createConnectorApp({ name: 'test', version: '1.0.0' });
    app.post('/echo', (req, res) => res.json(req.body));
    const res = await request(app).post('/echo').send({ hello: 'world' });
    expect(res.body).toEqual({ hello: 'world' });
  });

  it('should expose Mcp-Session-Id in CORS headers', async () => {
    const app = createConnectorApp({ name: 'test', version: '1.0.0' });
    const res = await request(app)
      .options('/tools')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-expose-headers']).toContain('Mcp-Session-Id');
  });

  it('should allow custom body limit', async () => {
    const app = createConnectorApp({ name: 'test', version: '1.0.0', bodyLimit: '1kb' });
    app.post('/echo', (req, res) => res.json(req.body));
    const largeBody = { data: 'x'.repeat(2000) };
    const res = await request(app).post('/echo').send(largeBody);
    expect(res.status).toBe(413);
  });

  it('should set trust proxy by default', async () => {
    const app = createConnectorApp({ name: 'test', version: '1.0.0' });
    expect(app.get('trust proxy')).toBe(true);
  });

  it('should allow disabling trust proxy', async () => {
    const app = createConnectorApp({ name: 'test', version: '1.0.0', trustProxy: false });
    expect(app.get('trust proxy')).toBe(false);
  });
});
