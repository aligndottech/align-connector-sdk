/**
 * Shared Gateway API client for all communication connectors
 * Provides consistent API access to the Align Gateway service
 *
 * This is the SINGLE SOURCE OF TRUTH for Gateway API access.
 * DO NOT create duplicate GatewayRepository implementations in connector packages.
 */

import { fetch } from 'undici';
import type {
  ConsensusResponse,
  ConversationalRequest,
  ConversationalResponse,
  CreateIssueParams,
  CreateIssueResult,
  Decision,
  DecisionSearchOptions,
  DecisionSearchResponse,
  DecisionSnapshot,
  EpicSuggestion,
  IngestPayload,
  IngestResponse,
  Issue,
  IssueSearchResult,
  JiraProject,
  JiraSettings,
  StreamEvent,
} from '../types/index.js';

/**
 * Jira credentials from Gateway
 */
export interface JiraCredentials {
  base: string;
  token: string;
  cloudId?: string;
}

export interface GatewayClientConfig {
  gatewayUrl: string;
  bearerToken?: string;
}

/**
 * Parse an SSE stream into typed StreamEvent objects.
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<StreamEvent> {
  if (!body) {
    yield { type: 'error', data: { error: 'No response body' } };
    return;
  }

  const reader = (body as unknown as { getReader(): ReadableStreamDefaultReader<Uint8Array> }).getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function* parseBuffer(raw: string): Generator<StreamEvent> {
    const parts = raw.split('\n\n');
    for (const part of parts) {
      if (!part.trim()) continue;
      let eventType = '';
      let eventData = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) eventData = line.slice(6);
      }
      if (eventType && eventData) {
        try {
          yield { type: eventType as StreamEvent['type'], data: JSON.parse(eventData) };
        } catch {
          // skip malformed JSON
        }
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      yield* parseBuffer(parts.join('\n\n'));
    }

    // Parse any remaining buffer after stream ends
    if (buffer.trim()) {
      yield* parseBuffer(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Shared client for Gateway API operations
 */
export class GatewayClient {
  private gatewayUrl: string;
  private bearerToken?: string;

  constructor(config: GatewayClientConfig) {
    this.gatewayUrl = config.gatewayUrl;
    this.bearerToken = config.bearerToken;
  }

  /**
   * Create from environment variables
   */
  static fromEnv(): GatewayClient {
    return new GatewayClient({
      gatewayUrl: process.env.GATEWAY_URL || 'http://gateway:8080',
      bearerToken: process.env.GATEWAY_BEARER_TOKEN,
    });
  }

  /**
   * Make authenticated request to Gateway
   */
  protected async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      tenantId?: string;
    } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {};

    if (options.body) {
      headers['content-type'] = 'application/json';
    }

    if (this.bearerToken) {
      headers['authorization'] = `Bearer ${this.bearerToken}`;
    }

    if (options.tenantId) {
      headers['x-tenant-id'] = options.tenantId;
    }

    const response = await fetch(`${this.gatewayUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`gateway_request_failed ${path} ${response.status}: ${text}`);
    }

    // Handle void responses (204 No Content or empty body)
    const contentType = response.headers.get('content-type');
    if (response.status === 204 || !contentType?.includes('application/json')) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  // ===========================================================================
  // Decision Operations
  // ===========================================================================

  /**
   * Send ingest payload to Gateway for decision extraction
   */
  async ingest(tenantId: string, payload: IngestPayload): Promise<IngestResponse> {
    return this.request<IngestResponse>('/ingest', {
      method: 'POST',
      body: payload,
      tenantId,
    });
  }

  /**
   * Send payload to Gateway for consensus analysis of a debate
   */
  async consensus(tenantId: string, payload: IngestPayload): Promise<ConsensusResponse> {
    return this.request<ConsensusResponse>('/ingest/consensus', {
      method: 'POST',
      body: payload,
      tenantId,
    });
  }

  /**
   * Send payload to Gateway for conversational AI processing
   * Detects intent (decision, consensus, question, etc.) and returns appropriate response
   */
  async conversational(
    tenantId: string,
    payload: ConversationalRequest
  ): Promise<ConversationalResponse> {
    return this.request<ConversationalResponse>('/ingest/conversational', {
      method: 'POST',
      body: payload,
      tenantId,
    });
  }

  /**
   * Stream conversational AI response via SSE.
   * Yields events: { type: 'token', data: { text: string } }
   *             or { type: 'complete', data: ConversationalResponse }
   *             or { type: 'error', data: { error: string } }
   */
  async *streamConversational(
    tenantId: string,
    payload: ConversationalRequest,
  ): AsyncGenerator<StreamEvent> {
    const url = `${this.gatewayUrl}/ingest/conversational/stream`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
      'Accept': 'text/event-stream',
    };
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: 'error', data: { error: `Gateway error ${response.status}: ${errorText}` } };
      return;
    }

    yield* parseSSEStream((response.body as any) ?? null);
  }

  /**
   * Fetch decision details by ID
   */
  async getDecision(tenantId: string, decisionId: string): Promise<Decision> {
    return this.request<Decision>(`/snapshots/${decisionId}`, { tenantId });
  }

  /**
   * Search decisions using smart search (auto-selects semantic vs keyword)
   */
  async searchDecisions(
    tenantId: string,
    query: string,
    options?: DecisionSearchOptions,
  ): Promise<DecisionSearchResponse> {
    return this.request<DecisionSearchResponse>('/decisions/smart-search', {
      method: 'POST',
      body: {
        query,
        limit: options?.limit ?? 5,
        exclude_superseded: options?.exclude_superseded ?? true,
      },
      tenantId,
    });
  }

  /**
   * Fetch multiple decisions by IDs in a single request
   */
  async getDecisions(tenantId: string, decisionIds: string[]): Promise<Decision[]> {
    if (decisionIds.length === 0) return [];
    return this.request<Decision[]>('/snapshots/batch', {
      method: 'POST',
      body: { ids: decisionIds },
      tenantId,
    });
  }

  // ===========================================================================
  // Issue Operations
  // ===========================================================================

  /**
   * Search for issues across enabled connectors
   */
  async searchIssues(
    tenantId: string,
    keywords: string,
    sourceText?: string
  ): Promise<IssueSearchResult> {
    return this.request<IssueSearchResult>('/issues/search', {
      method: 'POST',
      body: { keywords, sourceText },
      tenantId,
    });
  }

  /**
   * Create an issue in the specified connector
   */
  async createIssue(tenantId: string, params: CreateIssueParams): Promise<CreateIssueResult> {
    return this.request<CreateIssueResult>('/issues/create', {
      method: 'POST',
      body: {
        connector: params.connector,
        project_key: params.projectKey,
        summary: params.summary,
        description: params.description,
        issue_type: params.issueType,
        labels: params.labels?.length ? params.labels : undefined,
        components: params.components?.length ? params.components : undefined,
        priority: params.priority || undefined,
        epic_key: params.epicKey || undefined,
      },
      tenantId,
    });
  }

  /**
   * Link a decision to an issue
   */
  async linkDecisionToIssue(
    tenantId: string,
    decisionId: string,
    issue: Issue
  ): Promise<void> {
    await this.request<void>(`/decisions/${decisionId}/link-issue`, {
      method: 'POST',
      body: {
        connector: issue.connector,
        external_id: issue.issueKey,
        external_url: issue.url,
        reference_type: 'tracks',
        metadata: {
          title: issue.title,
          status: issue.status,
          project_key: issue.projectKey,
        },
      },
      tenantId,
    });
  }

  // ===========================================================================
  // JIRA-specific Operations
  // ===========================================================================

  /**
   * Fetch JIRA tenant settings
   */
  async getJiraSettings(tenantId: string): Promise<JiraSettings> {
    try {
      return await this.request<JiraSettings>('/integrations/jira/settings', { tenantId });
    } catch {
      return { configured: false };
    }
  }

  /**
   * Save JIRA tenant settings (e.g. default project key)
   */
  async saveJiraSettings(
    tenantId: string,
    settings: { default_project_key?: string; default_project_id?: string }
  ): Promise<void> {
    await this.request<void>('/integrations/jira/settings', {
      method: 'PUT',
      body: settings,
      tenantId,
    });
  }

  /**
   * Fetch available JIRA projects
   */
  async getJiraProjects(tenantId: string): Promise<JiraProject[]> {
    const result = await this.request<{ projects: JiraProject[] }>(
      '/integrations/jira/projects',
      { tenantId }
    );
    return result.projects || [];
  }

  /**
   * Get AI-suggested epic for a decision
   */
  async suggestEpic(
    tenantId: string,
    projectKey: string,
    title: string,
    description: string,
    goals: string[]
  ): Promise<EpicSuggestion | null> {
    try {
      const result = await this.request<{ suggestion?: EpicSuggestion }>(
        '/integrations/jira/suggest-epic',
        {
          method: 'POST',
          body: { projectKey, title, description, goals },
          tenantId,
        }
      );
      return result.suggestion || null;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Snapshot Operations (used by Slack)
  // ===========================================================================

  /**
   * Get a decision snapshot by ID
   */
  async getSnapshot(tenantId: string, decisionId: string): Promise<DecisionSnapshot> {
    return this.request<DecisionSnapshot>(`/snapshots/${decisionId}`, { tenantId });
  }

  /**
   * Update decision source URL
   */
  async updateDecisionSourceUrl(
    tenantId: string,
    decisionId: string,
    sourceUrl: string
  ): Promise<DecisionSnapshot> {
    return this.request<DecisionSnapshot>(`/snapshots/${decisionId}/update-source-url`, {
      method: 'PATCH',
      body: { source_url: sourceUrl },
      tenantId,
    });
  }

  // ===========================================================================
  // Issue Operations (extended - used by Slack)
  // ===========================================================================

  /**
   * Fetch a single issue by key
   */
  async fetchIssue(tenantId: string, issueKey: string): Promise<Issue> {
    return this.request<Issue>(`/issues/${issueKey}`, { tenantId });
  }

  /**
   * Add a comment to an issue
   */
  async addCommentToIssue(
    tenantId: string,
    issueKey: string,
    comment: { body: unknown }
  ): Promise<void> {
    await this.request<void>(`/issues/${issueKey}/comment`, {
      method: 'POST',
      body: comment,
      tenantId,
    });
  }

  // ===========================================================================
  // Slack-specific Conversation State (platform adapter)
  // ===========================================================================

  /**
   * Get Slack conversation state
   */
  async getSlackConversationState(
    tenantId: string,
    channelId: string,
    threadTs: string
  ): Promise<{ state: unknown } | null> {
    try {
      return await this.request<{ state: unknown }>(
        `/slack/conversation-state?channel_id=${channelId}&thread_ts=${threadTs}`,
        { tenantId }
      );
    } catch {
      return null;
    }
  }

  /**
   * Save Slack conversation state
   */
  async saveSlackConversationState(
    tenantId: string,
    data: unknown
  ): Promise<void> {
    await this.request<void>('/slack/conversation-state', {
      method: 'POST',
      body: data,
      tenantId,
    });
  }

  // ===========================================================================
  // Brain Operations (AI queries)
  // ===========================================================================

  /**
   * Query the Brain service
   */
  async queryBrain(
    tenantId: string,
    question: string,
    context: unknown
  ): Promise<{ answer: string; sources?: unknown[] }> {
    return this.request<{ answer: string; sources?: unknown[] }>('/brain/query', {
      method: 'POST',
      body: { question, context },
      tenantId,
    });
  }

  // ===========================================================================
  // Jira Credentials (used by mcp-jira)
  // ===========================================================================

  /**
   * Fetch Jira credentials for a tenant
   */
  async fetchJiraCredentials(tenantId: string): Promise<JiraCredentials> {
    const result = await this.request<{ base?: string; token?: string; cloudId?: string }>(
      '/integrations/jira/credentials',
      { tenantId }
    );

    if (!result.token) {
      throw new Error('jira_creds_missing');
    }

    return {
      base: result.base || '',
      token: result.token,
      cloudId: result.cloudId,
    };
  }

  // ===========================================================================
  // Slack Shortcuts
  // ===========================================================================

  /**
   * Trigger a Slack shortcut
   */
  async triggerSlackShortcut(tenantId: string, data: unknown): Promise<void> {
    await this.request<void>('/slack/shortcuts', {
      method: 'POST',
      body: data,
      tenantId,
    });
  }

}
