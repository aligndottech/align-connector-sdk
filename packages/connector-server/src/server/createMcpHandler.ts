import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';

export interface McpHandlerConfig {
  mcp: McpServer;
}

export interface McpHandler {
  (req: Request, res: Response): Promise<void>;
  getSessionCount(): number;
  cleanup(): Promise<void>;
  /**
   * Exposed for tests (mirrors align-stack's own `createMcpSessionStore.getOrCreateTransport`
   * pattern) - not part of the request-dispatch path's own contract, but the same function
   * `handler` itself calls, so a caller-controlled session id can be exercised directly
   * without needing a full HTTP/transport round-trip.
   */
  getOrCreateTransport(sessionId: string): Promise<StreamableHTTPServerTransport>;
}

export function createMcpHandler(config: McpHandlerConfig): McpHandler {
  const { mcp } = config;
  // Security review, ALI-1336 (follow-up to ALI-1337, which fixed the identical bug across
  // nine align-stack connectors): a plain object literal keyed by a caller-controlled
  // `Mcp-Session-Id` header resolves `transports['__proto__']` to `Object.prototype` itself
  // (every plain object inherits that accessor), not `undefined` - so a request naming that
  // exact session id got Object.prototype back as though it were a cached transport, and the
  // very next line (`transport.handleRequest(...)`) threw `TypeError: transport.handleRequest
  // is not a function` as an unhandled rejection, which crashes the whole connector process
  // (Node's default since v15). A `Map` has no such gotcha: `.get('__proto__')` is an ordinary
  // miss, so the caller gets a genuine session like any other id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Serialize transport creation to prevent concurrent close/connect races
  let pending: Promise<StreamableHTTPServerTransport> | null = null;

  async function getOrCreateTransport(sessionId: string): Promise<StreamableHTTPServerTransport> {
    const existing = transports.get(sessionId);
    if (existing) return existing;

    // Wait for any in-flight creation to finish before starting a new one
    if (pending) await pending.catch(() => {});

    // Re-check after awaiting
    const existingAfterWait = transports.get(sessionId);
    if (existingAfterWait) return existingAfterWait;

    const task = (async () => {
      // McpServer only supports one active transport at a time.
      // Close previous transports and disconnect before creating a new one.
      // Snapshot the keys first - deleting the CURRENT entry mid-iteration over a live Map
      // is spec-safe, but a snapshot keeps this identical in shape to the pre-fix
      // `Object.keys(transports)` loop rather than relying on that guarantee.
      for (const id of [...transports.keys()]) {
        await transports.get(id)?.close?.().catch(() => {});
        transports.delete(id);
      }
      await mcp.close().catch(() => {});

      const transport = new StreamableHTTPServerTransport({
        enableDnsRebindingProtection: true,
        sessionIdGenerator: () => sessionId,
      });

      await mcp.connect(transport);
      transports.set(sessionId, transport);
      return transport;
    })();

    pending = task;
    try {
      return await task;
    } finally {
      if (pending === task) pending = null;
    }
  }

  const handler: McpHandler = async (req: Request, res: Response) => {
    const headerId = req.header('Mcp-Session-Id');
    const sessionId = headerId && headerId.trim() !== '' ? headerId : randomUUID();
    const transport = await getOrCreateTransport(sessionId);

    await transport.handleRequest(req, res, req.body);

    if (req.method === 'DELETE') {
      await transport.close?.().catch(() => {});
      transports.delete(sessionId);
    }
  };

  handler.getSessionCount = () => transports.size;
  handler.getOrCreateTransport = getOrCreateTransport;

  handler.cleanup = async () => {
    for (const id of [...transports.keys()]) {
      await transports.get(id)?.close?.().catch(() => {});
      transports.delete(id);
    }
    await mcp.close().catch(() => {});
  };

  return handler;
}
