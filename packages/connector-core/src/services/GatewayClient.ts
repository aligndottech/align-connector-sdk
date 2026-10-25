/**
 * Shared Gateway API client for all communication connectors
 * Provides consistent API access to the Align Gateway service
 *
 * This is the SINGLE SOURCE OF TRUTH for Gateway API access.
 * DO NOT create duplicate GatewayRepository implementations in connector packages.
 */

import { fetch as undiciFetch } from 'undici';
import { GatewayBearerNotConfiguredError, normaliseBearer, resolveGatewayBearer } from './gatewayBearer.js';
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
  /** Without one, every call rejects with `gateway_bearer_not_configured` and sends nothing. */
  bearerToken?: string;
  /**
   * The fetch to call. Defaults to undici's. The client still refuses before calling it when no
   * bearer is configured, and whatever fetch is injected is trusted with the request headers,
   * including the bearer.
   */
  fetch?: typeof undiciFetch;
  /** Aborts any request still unanswered after this long. Not applied to streamConversational. */
  timeoutMs?: number;
}

/**
 * Headers the client builds itself, on a request or a stream. A caller's copy of any of these,
 * in any letter case, is dropped, so the built value is the only one on the wire.
 */
const BUILT_HEADERS = new Set(['authorization', 'x-tenant-id', 'content-type', 'accept']);

/** Caller headers: a plain object, a Headers instance, or an array of [name, value] pairs. */
export type GatewayCallerHeaders =
  | Record<string, string | undefined | null>
  | Iterable<readonly [string, string]>;

/**
 * Normalises caller headers to a plain object with lower-case names, the last of a repeated
 * name winning. Undefined and null values are skipped, and any other non-string value throws a
 * TypeError rather than being sent as text. Headers the client builds itself are dropped.
 */
function withoutBuiltHeaders(callerHeaders: GatewayCallerHeaders | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  if (callerHeaders == null) return kept;
  const pairs: Iterable<readonly [string, unknown]> =
    Symbol.iterator in callerHeaders ? callerHeaders : Object.entries(callerHeaders);
  for (const [key, value] of pairs) {
    const name = key.toLowerCase();
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new TypeError(`Header ${key} must be a string`);
    if (!BUILT_HEADERS.has(name)) kept[name] = value;
  }
  return kept;
}

/** AbortSignal.any, with a fallback for Node 20.0 to 20.2, where it does not exist. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
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
  // Runtime-private (#), unlike the TS-private fields: JSON.stringify and util.inspect skip it.
  #bearer?: string;
  #fetch: typeof undiciFetch;
  private timeoutMs?: number;

  constructor(config: GatewayClientConfig) {
    this.gatewayUrl = config.gatewayUrl;
    this.#bearer = normaliseBearer(config.bearerToken);
    this.#fetch = config.fetch ?? undiciFetch;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Create from environment variables
   */
  static fromEnv(): GatewayClient {
    return new GatewayClient({
      gatewayUrl: process.env.GATEWAY_URL || 'http://gateway:8080',
      bearerToken: resolveGatewayBearer(),
    });
  }

  private requireBearer(): string {
    if (!this.#bearer) throw new GatewayBearerNotConfiguredError();
    return this.#bearer;
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
      /**
       * Extra headers a caller wants attached (e.g. x-align-platform, ALI-691). Additive
       * only: a caller key that matches a header this method builds below (authorization,
       * x-tenant-id, content-type), in any letter case, is dropped, so a caller cannot
       * launder a request past them.
       */
      headers?: GatewayCallerHeaders;
      /** Aborts this request. Combined with the client's `timeoutMs` when both are set. */
      signal?: AbortSignal;
    } = {}
  ): Promise<T> {
    const headers = withoutBuiltHeaders(options.headers);

    if (options.body) {
      headers['content-type'] = 'application/json';
    }

    headers['authorization'] = `Bearer ${this.requireBearer()}`;

    if (options.tenantId) {
      headers['x-tenant-id'] = options.tenantId;
    }

    const signals = [options.signal, this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const response = await this.#fetch(`${this.gatewayUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: signals.length > 1 ? anySignal(signals) : signals[0],
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
   *
   * `options.headers` are extra headers for this call only (for example x-user-email). A caller
   * key matching authorization, x-tenant-id, content-type or accept, in any letter case, is
   * dropped. `options.signal` aborts the stream's fetch and its reader; the generator then
   * rejects with the signal's reason. There is no default timeout on a stream, by design: one
   * would cut a healthy stream.
   */
  streamConversational(
    tenantId: string,
    payload: ConversationalRequest,
    options: { headers?: GatewayCallerHeaders; signal?: AbortSignal } = {},
  ): AsyncGenerator<StreamEvent> {
    // Read at call time, not at the first next(): a generator is lazy, so a caller who mutates
    // its headers object between creating the stream and draining it must not change the request.
    // The bearer is still checked at the first next(), as before.
    return this.#stream(tenantId, payload, withoutBuiltHeaders(options.headers), options.signal);
  }

  async *#stream(
    tenantId: string,
    payload: ConversationalRequest,
    callerHeaders: Record<string, string>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<StreamEvent> {
    const url = `${this.gatewayUrl}/ingest/conversational/stream`;
    const headers: Record<string, string> = {
      ...callerHeaders,
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
      'Accept': 'text/event-stream',
      Authorization: `Bearer ${this.requireBearer()}`,
    };

    const response = await this.#fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
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
