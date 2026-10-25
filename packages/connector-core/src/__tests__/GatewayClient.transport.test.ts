import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Response } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../services/GatewayClient.js';

// No vi.mock('undici') here, unlike GatewayClient.test.ts: these cases need the real fetch so a
// request is a socket on a real server, and the injected-fetch cases need the real default to
// be distinguishable from the injected one.

type InjectedFetch = NonNullable<ConstructorParameters<typeof GatewayClient>[0]['fetch']>;

/** A fetch that records every call and answers 200 with an empty JSON object. */
function recordingFetch() {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetchFn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Record<string, unknown> });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as InjectedFetch;
  return { fetchFn, calls };
}

/** Exposes the protected request() seam that subclasses (and these tests) build on. */
class Probe extends GatewayClient {
  call<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>(path, options);
  }
}

/**
 * A real HTTP server, so "no request was sent" is a hit counter on a socket rather than a
 * claim by the code under test. `hang` leaves the response open so an abort has something to cut.
 */
async function startServer(hang = false) {
  const seen: IncomingMessage[] = [];
  const closed: Promise<void>[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req);
    closed.push(new Promise((resolve) => res.on('close', () => resolve())));
    if (hang) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    closed,
    stop: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const NOT_CONFIGURED = { code: 'gateway_bearer_not_configured' };

describe('GatewayClient transport', () => {
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    // Both sides of every env-dependent case are set by the test, never by the runner.
    vi.stubEnv('GATEWAY_BEARER_TOKEN', undefined);
    vi.stubEnv('SERVICE_AUTH_TOKEN', undefined);
    vi.stubEnv('GATEWAY_URL', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await stop?.();
    stop = undefined;
  });

  describe('fails closed when no bearer resolves', () => {
    it('fromEnv with neither variable set rejects and sends no request', async () => {
      const server = await startServer();
      stop = server.stop;
      vi.stubEnv('GATEWAY_URL', server.url);

      await expect(GatewayClient.fromEnv().getDecision('t1', 'd1')).rejects.toMatchObject(NOT_CONFIGURED);

      expect(server.seen).toHaveLength(0);
    });

    it('fromEnv with blank values in both variables rejects and sends no request', async () => {
      const server = await startServer();
      stop = server.stop;
      vi.stubEnv('GATEWAY_URL', server.url);
      vi.stubEnv('GATEWAY_BEARER_TOKEN', '   ');
      vi.stubEnv('SERVICE_AUTH_TOKEN', '');

      await expect(GatewayClient.fromEnv().getDecision('t1', 'd1')).rejects.toMatchObject(NOT_CONFIGURED);

      expect(server.seen).toHaveLength(0);
    });

    it('a client built without a bearer rejects request() and sends nothing', async () => {
      const { fetchFn, calls } = recordingFetch();
      const client = new GatewayClient({ gatewayUrl: 'http://gw.test', fetch: fetchFn });

      await expect(client.getDecision('t1', 'd1')).rejects.toMatchObject(NOT_CONFIGURED);

      expect(calls).toHaveLength(0);
    });

    it('a client built without a bearer rejects streamConversational() and sends nothing', async () => {
      const { fetchFn, calls } = recordingFetch();
      const client = new GatewayClient({ gatewayUrl: 'http://gw.test', fetch: fetchFn });

      await expect(client.streamConversational('t1', {} as never).next()).rejects.toMatchObject(NOT_CONFIGURED);

      expect(calls).toHaveLength(0);
    });

    it('positive control: with a bearer the same call reaches the server exactly once', async () => {
      const server = await startServer();
      stop = server.stop;
      vi.stubEnv('GATEWAY_URL', server.url);
      vi.stubEnv('GATEWAY_BEARER_TOKEN', 'relay-key');

      await GatewayClient.fromEnv().getDecision('t1', 'd1');

      expect(server.seen).toHaveLength(1);
    });
  });

  describe('fromEnv resolves GATEWAY_BEARER_TOKEN first, then SERVICE_AUTH_TOKEN', () => {
    async function authorizationSent(): Promise<string | undefined> {
      const server = await startServer();
      stop = server.stop;
      vi.stubEnv('GATEWAY_URL', server.url);
      await GatewayClient.fromEnv().getDecision('t1', 'd1');
      return server.seen[0]?.headers.authorization;
    }

    it('uses GATEWAY_BEARER_TOKEN when only it is set', async () => {
      vi.stubEnv('GATEWAY_BEARER_TOKEN', 'relay-key');
      expect(await authorizationSent()).toBe('Bearer relay-key');
    });

    it('uses SERVICE_AUTH_TOKEN when only it is set', async () => {
      vi.stubEnv('SERVICE_AUTH_TOKEN', 'shared-token');
      expect(await authorizationSent()).toBe('Bearer shared-token');
    });

    it('prefers GATEWAY_BEARER_TOKEN when both are set', async () => {
      vi.stubEnv('GATEWAY_BEARER_TOKEN', 'relay-key');
      vi.stubEnv('SERVICE_AUTH_TOKEN', 'shared-token');
      expect(await authorizationSent()).toBe('Bearer relay-key');
    });

    it('falls through a blank GATEWAY_BEARER_TOKEN to a trimmed SERVICE_AUTH_TOKEN', async () => {
      vi.stubEnv('GATEWAY_BEARER_TOKEN', '  ');
      vi.stubEnv('SERVICE_AUTH_TOKEN', ' shared-token ');
      expect(await authorizationSent()).toBe('Bearer shared-token');
    });
  });

  describe('timeouts and signals abort the request', () => {
    // The server holds the response open. Without a real abort its side of the socket stays
    // open until undici's own 5-minute timeouts, so "the server saw it close" is the evidence.
    async function serverSawClose(server: { closed: Promise<void>[] }): Promise<boolean> {
      const grace = new Promise<false>((resolve) => setTimeout(() => resolve(false), 1500));
      const closed = Promise.all(server.closed).then(() => true as const);
      return Promise.race([closed, grace]);
    }

    it('timeoutMs rejects the call and closes the socket', async () => {
      const server = await startServer(true);
      stop = server.stop;
      const client = new GatewayClient({ gatewayUrl: server.url, bearerToken: 'k', timeoutMs: 50 });

      await expect(client.getDecision('t1', 'd1')).rejects.toBeInstanceOf(Error);

      expect(server.seen).toHaveLength(1);
      expect(await serverSawClose(server)).toBe(true);
    });

    it('a different timeoutMs times out at that value, not a fixed one', async () => {
      const server = await startServer(true);
      stop = server.stop;
      const client = new GatewayClient({ gatewayUrl: server.url, bearerToken: 'k', timeoutMs: 400 });

      const started = Date.now();
      await expect(client.getDecision('t1', 'd1')).rejects.toBeInstanceOf(Error);

      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    });

    it('a per-call signal rejects the call and closes the socket', async () => {
      const server = await startServer(true);
      stop = server.stop;
      const client = new Probe({ gatewayUrl: server.url, bearerToken: 'k' });
      const controller = new AbortController();

      const pending = client.call('/anything', { signal: controller.signal });
      const assertion = expect(pending).rejects.toBeInstanceOf(Error);
      await vi.waitFor(() => expect(server.seen).toHaveLength(1));
      controller.abort();
      await assertion;

      expect(await serverSawClose(server)).toBe(true);
    });

    it('a per-call signal that is already aborted never reaches the server', async () => {
      const server = await startServer(true);
      stop = server.stop;
      const client = new Probe({ gatewayUrl: server.url, bearerToken: 'k' });

      await expect(client.call('/anything', { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);

      expect(server.seen).toHaveLength(0);
    });

    it('the per-call signal still aborts when a client timeout is also set', async () => {
      const server = await startServer(true);
      stop = server.stop;
      const client = new Probe({ gatewayUrl: server.url, bearerToken: 'k', timeoutMs: 60_000 });
      const controller = new AbortController();

      const pending = client.call('/anything', { signal: controller.signal });
      const assertion = expect(pending).rejects.toBeInstanceOf(Error);
      await vi.waitFor(() => expect(server.seen).toHaveLength(1));
      controller.abort();
      await assertion;

      expect(await serverSawClose(server)).toBe(true);
    });
  });

  describe('an injected fetch is the one that is called', () => {
    it('request() goes through it, with the resolved URL and headers', async () => {
      const { fetchFn, calls } = recordingFetch();
      const client = new GatewayClient({ gatewayUrl: 'http://gw.test', bearerToken: 'k', fetch: fetchFn });

      await client.getDecision('tenant-9', 'dec-1');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://gw.test/snapshots/dec-1');
      expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer k', 'x-tenant-id': 'tenant-9' });
    });

    it('streamConversational() goes through it too', async () => {
      const { fetchFn, calls } = recordingFetch();
      const client = new GatewayClient({ gatewayUrl: 'http://gw.test', bearerToken: 'k', fetch: fetchFn });

      await client.streamConversational('tenant-9', {} as never).next();

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://gw.test/ingest/conversational/stream');
    });
  });
});
