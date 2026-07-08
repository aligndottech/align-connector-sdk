/**
 * Shared types for communication connectors (Slack, Teams, etc.)
 *
 * This is the SINGLE SOURCE OF TRUTH for types shared across:
 * - mcp-teams connector
 * - mcp-jira connector
 * - mcp-slack connector
 * - Gateway service (where applicable)
 *
 * DO NOT duplicate these types in connector packages.
 */

// ============================================================================
// Actionable Items & AI Analysis Types
// ============================================================================

/**
 * Type of actionable item extracted from decisions
 */
export type ActionableItemType = 'question' | 'risk' | 'ambiguity';

/**
 * Priority level for actionable items
 */
export type ActionableItemPriority = 'high' | 'medium' | 'low';

/**
 * Status of an actionable item
 */
export type ActionableItemStatus = 'open' | 'in_progress' | 'resolved' | 'deferred' | 'mitigated' | 'accepted';

/**
 * An actionable item (question, risk, or ambiguity) extracted from a decision
 */
export interface ActionableItem {
  id: string;
  type: ActionableItemType;
  text: string;
  context?: string;
  status?: string;
  priority?: ActionableItemPriority;
  assignedTo?: string;
  dueDate?: string;
  resolutionSummary?: string;
  mitigationStrategy?: string;
  clarification?: string;
}

/**
 * Action item with owner and due date
 */
export interface Action {
  text: string;
  owner?: string;
  dueDate?: string;
  due?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked';
  completed_at?: string;
}

/**
 * AI analysis result from decision processing
 */
export interface AIResult {
  goals?: string[];
  decisions?: string[];
  questions?: string[];
  risks?: string[];
  actions?: Action[];
  owners?: string[];
  tags?: string[];
  links?: string[];
  rationale?: string;
  work_item_type?: string;
  acceptance_criteria?: string;
  gherkin?: string;
  confidence?: number;
  actionableItems?: ActionableItem[];
}

/**
 * Ambiguity analysis for a decision
 */
export interface AmbiguityAnalysis {
  score: number;
  reasons?: string[];
  vagueTerms?: string[];
  missingContext?: string[];
  contradictions?: string[];
}

// ============================================================================
// Decision Types
// ============================================================================

/**
 * Canonical relationship vocabulary for the decision graph.
 *
 * This is the SINGLE SOURCE OF TRUTH shared by the gateway engine and the CLI
 * local path (ALI-219). The `DecisionRelationship` type is derived from it, so the
 * type and the runtime list can never drift. Consumers that parse an LLM's chosen
 * type (e.g. the CLI classifier) must validate against this with
 * `isDecisionRelationship` and coerce/drop anything outside it - the graph's DB
 * CHECK constraint only accepts these values.
 */
export const DECISION_RELATIONSHIPS = [
  'supersedes',
  'conflicts_with',
  'contradicts',
  'duplicates',
  'clarifies',
  'relates',
  'refines',
  'supports',
  'questions',
  'blocks',
] as const;

/**
 * Relationship types between decisions
 */
export type DecisionRelationship = (typeof DECISION_RELATIONSHIPS)[number];

/**
 * Runtime type-guard: is `value` a canonical decision relationship?
 * Lets consumers narrow an untrusted string (e.g. parsed LLM output) to
 * `DecisionRelationship` and reject non-canonical types before they reach the graph.
 */
export function isDecisionRelationship(value: unknown): value is DecisionRelationship {
  return (
    typeof value === 'string' &&
    (DECISION_RELATIONSHIPS as readonly string[]).includes(value)
  );
}

/**
 * A related decision with relationship metadata
 */
export interface RelatedDecision {
  id: string;
  title?: string;
  summary?: string;
  relationship: DecisionRelationship;
  confidence: number;
  similarity?: number;
  reasons?: string[];
  suggestedActions?: string[];
  source_url?: string;
}

/**
 * Analysis of a decision's relationships and quality
 */
export interface DecisionAnalysis {
  isNew: boolean;
  relatedDecisions: RelatedDecision[];
  ambiguityAnalysis?: AmbiguityAnalysis;
  suggestedActions?: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Decision status
 */
export type DecisionStatus = 'active' | 'superseded' | 'conflicted' | 'ambiguous' | 'clarified' | 'archived';

/**
 * Core decision interface
 */
export interface Decision {
  id: string;
  title: string;
  summary: string;
  decision_json: {
    context?: unknown;
    raw_text?: string;
    ai?: AIResult;
  };
}

/**
 * Full decision snapshot from database
 */
export interface DecisionSnapshot {
  id: string;
  tenant_id: string;
  source_url: string;
  platform: string;
  title: string;
  summary: string;
  decision_json: {
    context?: unknown;
    raw_text?: string;
    ai?: AIResult;
  };
  ai?: AIResult;
  embedding?: number[];
  status?: DecisionStatus;
  ambiguity_score?: number;
  ambiguity_reasons?: string[];
  is_primary?: boolean;
  primary_decision_id?: string;
  source_reference?: string;
  merged_into_primary_at?: string;
  superseded_by?: string;
  created_at: string;
  updated_at?: string;
  created_by?: string;
  analysis?: DecisionAnalysis;
}

// ============================================================================
// Decision Search Types
// ============================================================================

/**
 * A single result from a decision search query
 */
export interface DecisionSearchResult {
  id: string;
  source_url: string;
  platform: string;
  title: string;
  summary: string;
  created_at: string;
  decision_json?: {
    context?: unknown;
    raw_text?: string;
    ai?: AIResult;
  };
  status?: DecisionStatus;
  similarity?: number;
}

/**
 * Response from the decision search endpoint
 */
export interface DecisionSearchResponse {
  query: string;
  results: DecisionSearchResult[];
  count: number;
  strategy: 'semantic' | 'keyword';
}

/**
 * Options for searching decisions
 */
export interface DecisionSearchOptions {
  limit?: number;
  exclude_superseded?: boolean;
}

// ============================================================================
// Issue Types
// ============================================================================

export type IssueConnector = 'jira' | 'linear' | 'github';

export interface Issue {
  connector: IssueConnector;
  issueKey: string;
  title?: string;
  url?: string;
  status?: string;
  projectKey?: string;
}

export interface JiraSettings {
  configured: boolean;
  settings?: {
    default_project_key?: string;
    default_issue_type?: string;
    default_labels?: string[];
    default_components?: string[];
    default_priority?: string;
    default_epic_key?: string;
  };
}

export interface JiraProject {
  key: string;
  name: string;
}

export interface EpicSuggestion {
  type: 'EXISTING_EPIC' | 'NEW_EPIC';
  epicKey?: string;
  epicName?: string;
}

export interface CreateIssueParams {
  connector: IssueConnector;
  projectKey: string;
  summary: string;
  description: unknown;
  issueType: string;
  labels?: string[];
  components?: string[];
  priority?: string;
  epicKey?: string;
}

export interface CreateIssueResult {
  key: string;
  issueKey?: string;
  url?: string;
}

// ============================================================================
// Bulk Issue Creation Types
// ============================================================================

export interface BulkIssueCreationRequest {
  decisionId: string;
  title: string;
}

export interface BulkIssueResult {
  decisionId: string;
  title: string;
  success: boolean;
  error?: string;
  issueKey?: string;
  issueUrl?: string;
}

export interface BulkIssueCreationResult {
  type: 'completed' | 'needs_project_selection';
  results?: BulkIssueResult[];
  projects?: JiraProject[];
  createdCount?: number;
  failedCount?: number;
}

// ============================================================================
// Command Types
// ============================================================================

export type CommandAction =
  | { type: 'merge_all' }
  | { type: 'merge_single'; index: number }
  | { type: 'merge_specific'; indices: number[] }
  | { type: 'keep_new' }
  | { type: 'keep_old' }
  | { type: 'keep_both' }
  | { type: 'accept_supersession' }
  | { type: 'reject_supersession' }
  | { type: 'link_issue'; issueKey: string }
  | { type: 'create_issue'; projectKey?: string }
  | { type: 'skip' }
  | { type: 'help' }
  | { type: 'greeting' }
  | { type: 'unknown' };

// ============================================================================
// Conversation State Types
// ============================================================================

export type ConversationAction =
  | 'awaiting_conflict_action'
  | 'awaiting_issue_action'
  | 'awaiting_project_selection'
  | 'awaiting_epic_selection'
  | null;

export interface ConversationState {
  action: ConversationAction;
  related_decisions?: RelatedDecision[];
  issues?: Issue[];
  searchText?: string;
  decision_title?: string;
  decision_id?: string;
  suggestedEpicKey?: string;
  suggestedEpicName?: string;
  selectedProjectKey?: string;
}

export interface StoredConversationState {
  id: string;
  tenant_id: string;
  platform: 'slack' | 'teams';
  conversation_id: string;
  channel_id: string;
  decision_id?: string;
  state: ConversationState;
  user_id?: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Gateway API Types
// ============================================================================

export interface IngestPayload {
  source_url: string;
  platform: DecisionPlatform;
  raw_text: string;
  message_id: string;
  conversation_id: string;
  is_meeting_chat?: boolean;
}

/**
 * Response from Gateway /ingest endpoint
 */
export interface IngestResponse {
  id: string;
  tenant_id?: string;
  source_url?: string;
  platform?: string;
  title?: string;
  summary?: string;
  decision_json?: unknown;
  ai?: AIResult;
  analysis?: DecisionAnalysis;
}

/**
 * Position in a debate for consensus analysis
 */
export interface ConsensusPosition {
  position: string;
  supporters: string[];
  evidence: string[];
}

/**
 * Proposed consensus from debate analysis
 */
export interface ProposedConsensus {
  title: string;
  summary: string;
  rationale: string;
  confidence: number;
}

/**
 * Response from Gateway /ingest/consensus endpoint
 */
export interface ConsensusResponse {
  type: 'consensus';
  source_url: string;
  platform: string;
  debate_summary: string;
  positions: ConsensusPosition[];
  areas_of_agreement: string[];
  areas_of_disagreement: string[];
  proposed_consensus: ProposedConsensus;
  open_questions: string[];
  suggested_next_steps: string[];
  confidence: number;
  trace?: Record<string, unknown>;
}

export interface IssueSearchResult {
  results: Issue[];
  explicitRefs: {
    jira: string[];
    linear: string[];
    ambiguous: string[];
  };
  enabledConnectors: string[];
}

// ============================================================================
// Platform-specific Adapters
// ============================================================================

/**
 * Platform-agnostic message sending interface
 */
export interface MessageSender {
  sendText(text: string): Promise<void>;
  sendCard(card: unknown): Promise<void>;
}

/**
 * Platform context for handling messages
 */
export interface PlatformContext {
  tenantId: string;
  conversationId: string;
  channelId: string;
  userId: string;
  platform: 'slack' | 'teams' | 'zoom';
  messageSender: MessageSender;
}

// ============================================================================
// Multi-Decision Extraction Types
// ============================================================================

/**
 * Action item extracted from a decision
 */
export interface ExtractedAction {
  text: string;
  owner?: string;
  due?: string;
  status?: string;
}

/**
 * A single decision extracted from a transcript
 */
export interface ExtractedDecision {
  /** Unique identifier for this pending decision (client-generated) */
  id: string;
  /** Short title for the decision */
  title: string;
  /** Brief summary of this decision segment */
  segment_summary: string;
  /** Timestamp where this decision starts in the transcript */
  start_timestamp?: string;
  /** Timestamp where this decision ends */
  end_timestamp?: string;
  /** Goals identified for this decision */
  goals: string[];
  /** Actual decisions made */
  decisions: string[];
  /** Unresolved questions */
  questions: string[];
  /** Identified risks */
  risks: string[];
  /** Action items with optional owner/due date */
  actions: ExtractedAction[];
  /** People responsible for this decision */
  owners: string[];
  /** Relevant tags */
  tags: string[];
  /** Rationale for the decision */
  rationale: string;
  /** Type of work item (user_story, technical_task, epic) */
  work_item_type: 'user_story' | 'technical_task' | 'epic';
  /** Acceptance criteria formatted by work item type */
  acceptance_criteria: string;
  /** Gherkin specification (for user stories) */
  gherkin: string;
  /** Confidence score 0-1 */
  confidence: number;
  /** Actionable items (questions, risks, ambiguities) */
  actionableItems?: ActionableItem[];
}

/**
 * Response from Brain /synthesize-multi endpoint
 */
export interface MultiDecisionResponse {
  decisions: ExtractedDecision[];
  decision_count: number;
  trace?: Record<string, unknown>;
}

/**
 * State for multi-decision review flow
 */
export interface MultiDecisionReviewState {
  /** Pending decisions to review */
  pending_decisions: ExtractedDecision[];
  /** Decisions that have been saved */
  saved_decision_ids: string[];
  /** Decisions that were skipped/removed */
  skipped_decision_ids: string[];
  /** Index of currently displayed decision (for carousel navigation) */
  current_index: number;
  /** Auto-save timeout in seconds (null means no auto-save) */
  auto_save_timeout_seconds?: number;
  /** When the auto-save timer started */
  auto_save_started_at?: string;
  /** Source information */
  source: {
    platform: 'slack' | 'teams';
    meeting_id?: string;
    meeting_subject?: string;
    transcript_url?: string;
    conversation_id: string;
  };
}

/**
 * Extended conversation state to include multi-decision review
 */
export type ExtendedConversationAction =
  | ConversationAction
  | 'awaiting_multi_decision_review';

export interface ExtendedConversationState extends Omit<ConversationState, 'action'> {
  action: ExtendedConversationAction;
  /** Multi-decision review state (when action is 'awaiting_multi_decision_review') */
  multi_decision?: MultiDecisionReviewState;
}

/**
 * Commands for multi-decision review
 */
export type MultiDecisionCommand =
  | { type: 'save_all' }
  | { type: 'save_current' }
  | { type: 'skip_current' }
  | { type: 'skip_all' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'edit'; decisionId: string }
  | { type: 'review' }  // Cancel auto-save and enter review mode
  | { type: 'show_list' };  // Show all pending decisions

// ============================================================================
// Shared Alert Data Types (for GitHub, Jira, etc.)
// ============================================================================

/**
 * Data for formatting a decision snapshot alert
 */
export interface DecisionAlertData {
  id: string;
  title?: string;
  summary?: string;
  goals?: string[];
  decisions?: string[];
  actions?: Action[];
  risks?: string[];
  questions?: string[];
  confidence?: number;
  ambiguityScore?: number;
  detailsUrl?: string;
}

/**
 * Data for formatting a conflict/duplicate/supersession alert
 */
export interface ConflictAlertData {
  conflictingDecisionId: string;
  conflictingDecisionTitle?: string;
  conflictingDecisionUrl?: string;
  relationshipType: 'conflicts_with' | 'duplicates' | 'supersedes';
  confidence: number;
  explanation?: string;
}

/**
 * Data for formatting a multiple duplicates alert
 */
export interface DuplicatesAlertData {
  duplicates: Array<{
    id: string;
    title?: string;
    url?: string;
    confidence: number;
  }>;
}

/**
 * Data for formatting an ambiguity alert
 */
export interface AmbiguityAlertData {
  score: number;
  reasons?: string[];
}

// ============================================================================
// Shared Decision Operations Types
// ============================================================================

/**
 * Types of decision operations
 */
export type DecisionOperationType =
  | 'merge'
  | 'supersession_accepted'
  | 'supersession_rejected'
  | 'conflict_resolved'
  | 'kept_both'
  | 'skip';

/**
 * Result of a decision operation (merge, supersession, etc.)
 */
export interface DecisionOperationResult {
  success: boolean;
  message: string;
  error?: string;
  /** The type of operation that was performed */
  operationType?: DecisionOperationType;
}

/**
 * Actions for conversation state (extended for all platforms)
 */
export type PlatformConversationAction =
  | 'awaiting_conflict_action'
  | 'awaiting_duplicate_action'
  | 'awaiting_supersession_action'
  | 'awaiting_issue_action'
  | 'awaiting_project_selection'
  | 'awaiting_epic_selection'
  | 'awaiting_multi_decision_review';

/**
 * Supported platforms for decision capture
 */
export type DecisionPlatform = 'slack' | 'teams' | 'github' | 'jira' | 'confluence' | 'zoom';

/**
 * Extended platform context supporting all platforms
 */
export interface ExtendedPlatformContext {
  tenantId: string;
  platform: DecisionPlatform;
  /** Unique conversation identifier (channel_ts for Slack, thread_id for Teams, pr_number for GitHub) */
  conversationId: string;
  /** Channel/repo identifier */
  channelId: string;
  /** User identifier */
  userId: string;
}

// ============================================================================
// Conversational AI Types
// ============================================================================

/**
 * Intent detected from user message
 */
export type ConversationalIntent =
  | 'consensus'    // Analyze team alignment
  | 'decision'     // Extract decision (routes to /ingest)
  | 'question'     // Answer a question
  | 'status'       // Show status info
  | 'help'         // Show help
  | 'transcript'   // Process pasted transcript
  | 'clarify';     // Need more info

/**
 * Single message in conversation history
 */
export interface ConversationMessage {
  author: string;
  content: string;
  timestamp?: string;
}

/**
 * Request for conversational AI endpoint
 */
export interface ConversationalRequest {
  message: string;
  conversation_history: ConversationMessage[];
  platform: DecisionPlatform;
  context: Record<string, unknown>;
  source_url?: string;
}

/**
 * Response from conversational AI endpoint
 */
export interface ConversationalResponse {
  intent: ConversationalIntent;
  response_text: string;
  structured_data?: {
    // For consensus
    debate_summary?: string;
    positions?: Array<{
      position: string;
      supporters?: string[];
      evidence?: string[];
    }>;
    areas_of_agreement?: string[];
    areas_of_disagreement?: string[];
    proposed_consensus?: {
      title: string;
      summary: string;
      rationale: string;
      confidence: number;
    };
    open_questions?: string[];
    suggested_next_steps?: string[];
    // For decision
    title?: string;
    summary?: string;
    decisions?: string[];
    owners?: string[];
  } | null;
  follow_up_prompts: string[];
  confidence: number;
}


// ============================================================================
// Streaming Types
// ============================================================================

/**
 * Server-Sent Event from streaming conversational AI endpoint
 */
export interface StreamEvent {
  type: 'token' | 'complete' | 'error';
  data: {
    text?: string;
    error?: string;
    intent?: string;
    response_text?: string;
    structured_data?: Record<string, unknown> | null;
    follow_up_prompts?: string[];
    confidence?: number;
    [key: string]: unknown;
  };
}

// ============================================================================
// Proactive Notification Types
// ============================================================================

/**
 * Payload sent from gateway → communication-tier connector for deferred conflict/supersession alerts.
 * Used by ALL communication connectors (Slack, Teams, Zoom, etc.) via DeferredNotificationHandler.
 *
 * Gateway sends this after performDeferredAnalysis() detects a conflict or supersession
 * with confidence >= 0.7, targeting the original thread/conversation where the decision was captured.
 */
export interface ConflictNotificationPayload {
  decisionId: string;
  decisionTitle: string;
  relatedId: string;
  relatedTitle: string;
  relationship: 'conflicts_with' | 'contradicts' | 'supersedes';
  confidence: number;
  severity: string;
  reasons: string[];
  /** Platform-specific channel ID where the original decision was captured. Null for non-chat platforms (Jira, GitHub). */
  sourceChannelId: string | null;
  /** Platform-specific thread/conversation ID. Null if posted at channel level. */
  sourceConversationId: string | null;
  /** Space/team names the new decision belongs to (for cross-scope display) */
  decisionSpaces?: string[];
  /** Space/team names the related decision belongs to */
  relatedSpaces?: string[];
  /** Suggested actions from the analysis (e.g. "Review and resolve conflict before proceeding") */
  suggestedActions?: string[];
}

/**
 * Payload sent from gateway -> communication-tier connector for stale decision digest DMs.
 * Gateway sends this weekly when decisions are past their review interval.
 * The connector formats a digest card and sends it as a DM to the user.
 */
export interface StaleDigestNotificationPayload {
  /** Platform-specific user ID to DM (Slack user ID, Teams email/AAD ID) */
  userId: string;
  /** Stale decisions for this user (capped at 10) */
  decisions: Array<{
    id: string;
    title: string;
    platform: string;
    created_at: string;
    last_reviewed_at: string | null;
    review_interval_days: number;
    days_overdue: number;
    source_url: string;
  }>;
  /** Total stale count including those beyond the cap */
  totalStaleCount: number;
}
