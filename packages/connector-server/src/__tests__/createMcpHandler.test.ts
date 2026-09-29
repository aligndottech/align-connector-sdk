import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler } from '../server/createMcpHandler.js';

describe('createMcpHandler', () => {
  it('should create a handler function for Express', () => {
    const mcp = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });
    const handler = createMcpHandler({ mcp });
    expect(typeof handler).toBe('function');
  });

  it('should start with zero sessions', () => {
    const mcp = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });
    const handler = createMcpHandler({ mcp });
    expect(handler.getSessionCount()).toBe(0);
  });

  it('should have a cleanup method', () => {
    const mcp = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });
    const handler = createMcpHandler({ mcp });
    expect(handler.cleanup).toBeDefined();
    expect(typeof handler.cleanup).toBe('function');
  });

  describe('untrusted sessionId cannot reach Object.prototype (ALI-1336, follow-up to ALI-1337)', () => {
    it('treats "__proto__" as an ordinary session id and leaves Object.prototype untouched', async () => {
      const mcp = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });
      const handler = createMcpHandler({ mcp });

      // A plain object's `transports['__proto__']` resolves to Object.prototype rather than
      // undefined, so the store must not use a bare object keyed directly by sessionId.
      const first = await handler.getOrCreateTransport('__proto__');
      const second = await handler.getOrCreateTransport('__proto__');

      expect(second).toBe(first); // ordinary session-reuse semantics for this id, same as any other
      // A genuine transport, not Object.prototype masquerading as one - the pre-fix bug
      // returned Object.prototype here, whose .handleRequest is undefined.
      expect(typeof first.handleRequest).toBe('function');
      expect(Object.prototype).not.toHaveProperty('handleRequest');
      // The pre-fix code never reaches the assignment that would grow this count for
      // "__proto__" - it short-circuits on the truthy Object.prototype "hit" instead.
      expect(handler.getSessionCount()).toBe(1);
    });
  });
});
