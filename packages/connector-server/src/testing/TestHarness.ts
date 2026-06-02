import type { Express, RequestHandler } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as McpServerImpl } from '@modelcontextprotocol/sdk/server/mcp.js';
import supertest from 'supertest';
import { type ConnectorAppConfig, createConnectorApp } from '../server/createConnectorApp.js';
import { createMcpHandler, type McpHandler } from '../server/createMcpHandler.js';
import { MockGatewayClient } from '@aligndottech/connector-core';

export interface TestHarnessConfig {
  name: string;
  version: string;
  setup: (app: Express, mcp: McpServer, gateway: MockGatewayClient) => void;
  appConfig?: Partial<ConnectorAppConfig>;
}

/**
 * Test harness for spinning up a connector with mock gateway.
 * Provides supertest-style HTTP assertions.
 */
export class TestHarness {
  private app: Express | null = null;
  private mcpHandler: McpHandler | null = null;
  readonly gateway = new MockGatewayClient();
  readonly mcp: McpServer;

  constructor(private config: TestHarnessConfig) {
    this.mcp = new McpServerImpl(
      { name: config.name, version: config.version },
      { capabilities: { tools: {} } }
    );
  }

  async start(): Promise<void> {
    this.app = createConnectorApp({
      name: this.config.name,
      version: this.config.version,
      ...this.config.appConfig,
    });

    this.mcpHandler = createMcpHandler({ mcp: this.mcp });
    this.app.all('/tools', this.mcpHandler as unknown as RequestHandler);

    this.config.setup(this.app, this.mcp, this.gateway);
  }

  async stop(): Promise<void> {
    if (this.mcpHandler) {
      await this.mcpHandler.cleanup();
      this.mcpHandler = null;
    }
    this.app = null;
    this.gateway.reset();
  }

  get(path: string) {
    return this.agent().get(path);
  }

  post(path: string) {
    return this.agent().post(path);
  }

  postWebhook(path: string, body: Record<string, unknown>) {
    return this.agent().post(path).send(body).set('Content-Type', 'application/json');
  }

  private agent() {
    if (!this.app) {
      throw new Error('TestHarness not started. Call start() first.');
    }
    return supertest(this.app);
  }
}
