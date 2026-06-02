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
}

export function createMcpHandler(config: McpHandlerConfig): McpHandler {
  const { mcp } = config;
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Serialize transport creation to prevent concurrent close/connect races
  let pending: Promise<StreamableHTTPServerTransport> | null = null;

  async function getOrCreateTransport(sessionId: string): Promise<StreamableHTTPServerTransport> {
    const existing = transports[sessionId];
    if (existing) return existing;

    // Wait for any in-flight creation to finish before starting a new one
    if (pending) await pending.catch(() => {});

    // Re-check after awaiting
    if (transports[sessionId]) return transports[sessionId];

    const task = (async () => {
      // McpServer only supports one active transport at a time.
      // Close previous transports and disconnect before creating a new one.
      for (const id of Object.keys(transports)) {
        await transports[id]?.close?.().catch(() => {});
        delete transports[id];
      }
      await mcp.close().catch(() => {});

      const transport = new StreamableHTTPServerTransport({
        enableDnsRebindingProtection: true,
        sessionIdGenerator: () => sessionId,
      });

      await mcp.connect(transport);
      transports[sessionId] = transport;
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
      delete transports[sessionId];
    }
  };

  handler.getSessionCount = () => Object.keys(transports).length;

  handler.cleanup = async () => {
    for (const id of Object.keys(transports)) {
      await transports[id]?.close?.().catch(() => {});
      delete transports[id];
    }
    await mcp.close().catch(() => {});
  };

  return handler;
}
