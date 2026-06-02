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
});
