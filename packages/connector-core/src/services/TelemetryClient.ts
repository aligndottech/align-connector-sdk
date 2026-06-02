/**
 * Telemetry Client for Connectors
 *
 * HTTP client for sending telemetry events to the Gateway.
 * Used by connectors that run in separate processes.
 */

import { fetch } from 'undici';

/**
 * Telemetry event categories
 */
export type TelemetryCategory =
  | 'engagement'
  | 'value'
  | 'quality'
  | 'system'
  | 'connector';

/**
 * Supported platforms
 */
export type TelemetryPlatform =
  | 'web'
  | 'slack'
  | 'teams'
  | 'github'
  | 'jira'
  | 'confluence'
  | 'linear'
  | 'api'
  | 'system';

/**
 * Telemetry event structure
 */
export interface TelemetryEvent {
  eventName: string;
  category: TelemetryCategory;
  platform?: TelemetryPlatform;
  connectorKey?: string;
  userId?: string;
  properties?: Record<string, unknown>;
  metrics?: Record<string, number>;
}

/**
 * Configuration for the telemetry client
 */
export interface TelemetryClientConfig {
  /** Gateway URL (e.g., http://gateway:8080) */
  gatewayUrl: string;
  /** Default platform for all events */
  defaultPlatform?: TelemetryPlatform;
  /** Default connector key */
  defaultConnectorKey?: string;
  /** Whether telemetry is enabled (default: true) */
  enabled?: boolean;
  /** Batch size before auto-flush (default: 10) */
  batchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushIntervalMs?: number;
  /** Request timeout in ms (default: 5000) */
  timeoutMs?: number;
  /** Logger function */
  logger?: (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Telemetry client for sending events to the Gateway.
 */
export class TelemetryClient {
  private readonly gatewayUrl: string;
  private readonly defaultPlatform?: TelemetryPlatform;
  private readonly defaultConnectorKey?: string;
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

  private eventBuffer: Array<TelemetryEvent & { tenantId: string }> = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private currentTenantId: string | null = null;

  constructor(config: TelemetryClientConfig) {
    this.gatewayUrl = config.gatewayUrl.replace(/\/$/, ''); // Remove trailing slash
    this.defaultPlatform = config.defaultPlatform;
    this.defaultConnectorKey = config.defaultConnectorKey;
    this.enabled = config.enabled ?? true;
    this.batchSize = config.batchSize ?? 10;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.log = config.logger ?? (() => {});

    // Start flush timer
    if (this.flushIntervalMs > 0) {
      this.startFlushTimer();
    }
  }

  /**
   * Set the current tenant ID for subsequent events.
   * Should be called when processing requests with tenant context.
   */
  setTenantId(tenantId: string): void {
    this.currentTenantId = tenantId;
  }

  /**
   * Track a telemetry event.
   */
  async track(
    event: TelemetryEvent,
    tenantId?: string
  ): Promise<void> {
    if (!this.enabled) return;

    const effectiveTenantId = tenantId ?? this.currentTenantId;
    if (!effectiveTenantId) {
      this.log('warn', 'Cannot track telemetry event without tenant ID', { eventName: event.eventName });
      return;
    }

    const fullEvent = {
      ...event,
      tenantId: effectiveTenantId,
      platform: event.platform ?? this.defaultPlatform,
      connectorKey: event.connectorKey ?? this.defaultConnectorKey,
    };

    this.eventBuffer.push(fullEvent);

    // Flush if buffer is full
    if (this.eventBuffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Track immediately without batching.
   */
  async trackImmediate(
    event: TelemetryEvent,
    tenantId?: string
  ): Promise<void> {
    if (!this.enabled) return;

    const effectiveTenantId = tenantId ?? this.currentTenantId;
    if (!effectiveTenantId) {
      this.log('warn', 'Cannot track telemetry event without tenant ID', { eventName: event.eventName });
      return;
    }

    const fullEvent = {
      ...event,
      platform: event.platform ?? this.defaultPlatform,
      connectorKey: event.connectorKey ?? this.defaultConnectorKey,
    };

    await this.sendEvents([fullEvent], effectiveTenantId);
  }

  /**
   * Flush all buffered events.
   */
  async flush(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    // Group events by tenant
    const eventsByTenant = new Map<string, TelemetryEvent[]>();
    for (const event of this.eventBuffer) {
      const { tenantId, ...eventData } = event;
      if (!eventsByTenant.has(tenantId)) {
        eventsByTenant.set(tenantId, []);
      }
      eventsByTenant.get(tenantId)!.push(eventData);
    }

    this.eventBuffer = [];

    // Send events for each tenant
    const promises = Array.from(eventsByTenant.entries()).map(([tenantId, events]) =>
      this.sendEvents(events, tenantId)
    );

    await Promise.all(promises);
  }

  /**
   * Shutdown the client, flushing remaining events.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Track a webhook event.
   */
  async trackWebhook(
    webhookId: string,
    eventType: string,
    success: boolean,
    durationMs: number,
    tenantId?: string
  ): Promise<void> {
    await this.track({
      eventName: success ? 'webhook.processed' : 'webhook.failed',
      category: 'connector',
      properties: { webhookId, eventType, success },
      metrics: { durationMs },
    }, tenantId);
  }

  /**
   * Track a command execution.
   */
  async trackCommand(
    command: string,
    success: boolean,
    durationMs: number,
    tenantId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    await this.track({
      eventName: success ? 'command.completed' : 'command.failed',
      category: 'engagement',
      properties: { command, success, ...properties },
      metrics: { durationMs },
    }, tenantId);
  }

  /**
   * Track a decision capture.
   */
  async trackDecisionCaptured(
    decisionId: string,
    captureMethod: 'slash_command' | 'auto_capture' | 'manual' | 'webhook',
    tenantId?: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    await this.track({
      eventName: 'decision.captured',
      category: 'engagement',
      properties: { decisionId, captureMethod, ...properties },
    }, tenantId);
  }

  /**
   * Track a conflict detection.
   */
  async trackConflictDetected(
    decisionId: string,
    conflictingDecisionId: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    tenantId?: string
  ): Promise<void> {
    await this.track({
      eventName: 'conflict.detected',
      category: 'value',
      properties: { decisionId, conflictingDecisionId, severity },
    }, tenantId);
  }

  /**
   * Track a Jira comment processed.
   */
  async trackJiraComment(
    issueKey: string,
    commentId: string,
    hasDecision: boolean,
    durationMs: number,
    tenantId?: string
  ): Promise<void> {
    await this.track({
      eventName: 'jira.comment',
      category: 'connector',
      platform: 'jira',
      properties: { issueKey, commentId, hasDecision },
      metrics: { durationMs },
    }, tenantId);
  }

  /**
   * Track a Jira issue linked.
   */
  async trackJiraIssueLinked(
    decisionId: string,
    issueKey: string,
    linkType: string,
    tenantId?: string
  ): Promise<void> {
    await this.track({
      eventName: 'jira.issue_linked',
      category: 'connector',
      platform: 'jira',
      properties: { decisionId, issueKey, linkType },
    }, tenantId);
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async sendEvents(events: TelemetryEvent[], tenantId: string): Promise<void> {
    try {
      const response = await fetch(`${this.gatewayUrl}/telemetry/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        this.log('warn', 'Failed to send telemetry events', {
          status: response.status,
          tenantId,
          count: events.length,
        });
      }
    } catch (error) {
      this.log('error', 'Error sending telemetry events', {
        error: error instanceof Error ? error.message : String(error),
        tenantId,
        count: events.length,
      });
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    // Don't block process exit
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }
}

/**
 * Create a telemetry client with standard configuration.
 */
export function createTelemetryClient(
  gatewayUrl: string,
  platform: TelemetryPlatform,
  options?: Partial<Omit<TelemetryClientConfig, 'gatewayUrl' | 'defaultPlatform'>>
): TelemetryClient {
  return new TelemetryClient({
    gatewayUrl,
    defaultPlatform: platform,
    defaultConnectorKey: platform,
    ...options,
  });
}
