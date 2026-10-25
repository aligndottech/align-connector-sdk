import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../services/GatewayClient.js';

// Real undici and real sockets, as in GatewayClient.transport.test.ts.

const COMPLETE = 'event: complete\ndata: {"intent":"question","response_text":"ok"}\n\n';

/**
 * An SSE server. It records the headers of every request. With `hang` it sends one token event
 * and then holds the response open, so an abort has a live stream to cut.
 */
async function startSse(hang = false) {
  const headersSeen: IncomingHttpHeaders[] = [];
  const rawHeaders: string[][] = [];
  const closed: Promise<void>[] = [];
  const server: Server = createServer((req, res) => {
    headersSeen.push(req.headers);
    rawHeaders.push(req.rawHeaders);
    closed.push(new Promise((resolve) => res.on('close', () => resolve())));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: token\ndata: {"text":"hi"}\n\n');
    if (!hang) res.end(COMPLETE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    headersSeen,
    rawHeaders,
    closed,
    stop: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function drain(gen: AsyncGenerator<{ type: string }>): Promise<string[]> {
  const types: string[] = [];
  for await (const event of gen) types.push(event.type);
  return types;
}

/** How many times a header name appears on the wire, in any letter case. */
function occurrences(raw: string[], name: string): number {
  return raw.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name).length;
}

describe('GatewayClient.streamConversational call options', () => {
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.stubEnv('GATEWAY_BEARER_TOKEN', undefined);
    vi.stubEnv('SERVICE_AUTH_TOKEN', undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await stop?.();
    stop = undefined;
  });

  const client = (url: string, bearerToken: string | undefined = 'real') =>
    new GatewayClient({ gatewayUrl: url, bearerToken });

  it('positive control: a two-argument call streams and sends the built headers', async () => {
    const server = await startSse();
    stop = server.stop;

    const types = await drain(client(server.url).streamConversational('tenant-1', {} as never));

    expect(types).toEqual(['token', 'complete']);
    expect(server.headersSeen[0]).toMatchObject({
      authorization: 'Bearer real',
      'x-tenant-id': 'tenant-1',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    });
    expect(server.headersSeen[0]['x-user-email']).toBeUndefined();
  });

  it('a caller header reaches the server', async () => {
    const server = await startSse();
    stop = server.stop;

    await drain(
      client(server.url).streamConversational('tenant-1', {} as never, {
        headers: { 'x-user-email': 'ada@example.com', 'x-align-platform': 'slack' },
      }),
    );

    expect(server.headersSeen[0]).toMatchObject({ 'x-user-email': 'ada@example.com', 'x-align-platform': 'slack' });
  });

  it('caller authorization, x-tenant-id, content-type and accept cannot override the built ones, in any case', async () => {
    const server = await startSse();
    stop = server.stop;

    await drain(
      client(server.url).streamConversational('real-tenant', {} as never, {
        headers: {
          Authorization: 'Bearer forged',
          'X-Tenant-Id': 'forged-tenant',
          'CONTENT-TYPE': 'text/plain',
          ACCEPT: 'text/html',
          'x-user-email': 'ada@example.com',
        },
      }),
    );

    const raw = server.rawHeaders[0];
    for (const name of ['authorization', 'x-tenant-id', 'content-type', 'accept']) {
      expect(occurrences(raw, name), name).toBe(1);
    }
    expect(server.headersSeen[0]).toMatchObject({
      authorization: 'Bearer real',
      'x-tenant-id': 'real-tenant',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-user-email': 'ada@example.com',
    });
  });

  it('two concurrent streams each send their own x-user-email', async () => {
    const server = await startSse();
    stop = server.stop;
    const c = client(server.url);

    await Promise.all([
      drain(c.streamConversational('t', {} as never, { headers: { 'x-user-email': 'ada@example.com' } })),
      drain(c.streamConversational('t', {} as never, { headers: { 'x-user-email': 'grace@example.com' } })),
      drain(c.streamConversational('t', {} as never)),
    ]);

    const emails = server.headersSeen.map((h) => h['x-user-email']);
    expect(emails).toHaveLength(3);
    expect(emails).toEqual(expect.arrayContaining(['ada@example.com', 'grace@example.com', undefined]));
  });

  it('an aborted signal closes the socket mid-stream and the generator rejects with AbortError', async () => {
    const server = await startSse(true);
    stop = server.stop;
    const controller = new AbortController();
    const gen = client(server.url).streamConversational('t', {} as never, { signal: controller.signal });

    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'token' }); // the stream is live
    const next = gen.next();
    const assertion = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;

    const grace = new Promise<false>((resolve) => setTimeout(() => resolve(false), 1500));
    expect(await Promise.race([Promise.all(server.closed).then(() => true as const), grace])).toBe(true);
  });

  it('an already-aborted signal never reaches the server', async () => {
    const server = await startSse(true);
    stop = server.stop;

    await expect(
      client(server.url).streamConversational('t', {} as never, { signal: AbortSignal.abort() }).next(),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(server.headersSeen).toHaveLength(0);
  });

  it.each(['   ', ''])('fails closed with bearer %j and the new options: rejects, sends nothing', async (blank) => {
    const server = await startSse();
    stop = server.stop;

    await expect(
      client(server.url, blank)
        .streamConversational('t', {} as never, { headers: { 'x-user-email': 'ada@example.com' }, signal: new AbortController().signal })
        .next(),
    ).rejects.toMatchObject({ code: 'gateway_bearer_not_configured' });

    expect(server.headersSeen).toHaveLength(0);
  });
});
