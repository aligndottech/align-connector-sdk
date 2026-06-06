/**
 * Decision-flow interfaces - the contracts a connector implements to participate
 * in real-time decision capture.
 *
 * These are INTERFACES only. The orchestration engine that drives them
 * (UnifiedConnectorFlow) and the concrete flow services (DecisionFlowService,
 * etc.) are proprietary and live in Align's hosted platform - a connector author
 * implements the interfaces here and the hosted engine calls them.
 */

import type { ConnectorTier as TierConnectorTier } from '../tiers/capabilities.js';
import type {
  DecisionOperationResult,
  DecisionPlatform,
  ExtractedDecision,
  IngestResponse,
  MultiDecisionCommand,
  MultiDecisionReviewState,
  PlatformContext,
  RelatedDecision,
} from './index.js';

/**
 * Platform-specific message/card that can be posted.
 * Each platform returns its native format (Slack blocks, Adaptive Card, Markdown, etc.)
 */
export type PlatformMessage = unknown;

/**
 * Interface for platform-specific alert formatting.
 * Each connector implements this with their native card/message format.
 */
export interface DecisionAlertFormatter {
  formatDecisionCard(params: {
    decisionId: string;
    title: string;
    summary: string;
    confidence?: number;
    detailsUrl?: string;
  }): Promise<PlatformMessage>;

  formatRelatedDecisionAlert(params: {
    currentDecisionId: string;
    currentDecisionTitle?: string;
    related: RelatedDecision;
    detailsUrl?: string;
  }): Promise<PlatformMessage>;

  formatConsolidatedDuplicatesAlert(params: {
    currentDecisionId: string;
    currentDecisionTitle?: string;
    duplicates: RelatedDecision[];
  }): Promise<PlatformMessage>;

  formatAmbiguityAlert(params: {
    score: number;
    reasons?: string[];
  }): Promise<PlatformMessage>;

  formatProcessingMessage(): PlatformMessage;
  formatErrorMessage(title: string, message: string): PlatformMessage;
  formatOperationResult(result: DecisionOperationResult): PlatformMessage;
}

/**
 * Interface for platform-specific message posting.
 */
export interface MessagePoster {
  postMessage(message: PlatformMessage): Promise<string>;
  updateMessage?(messageId: string, message: PlatformMessage): Promise<void>;
}

/**
 * State stored for interactive alert resolution.
 */
export interface DecisionFlowConversationState {
  action:
    | 'awaiting_conflict_action'
    | 'awaiting_duplicate_action'
    | 'awaiting_supersession_action';
  currentDecisionId: string;
  relatedDecisionId: string;
  relatedDecisionTitle?: string;
  relationship: 'conflicts_with' | 'duplicates' | 'supersedes';
  allRelatedDecisions?: Array<{
    id: string;
    title?: string;
    relationship: 'conflicts_with' | 'duplicates' | 'supersedes';
  }>;
}

/**
 * Commands for decision flow resolution.
 */
export type DecisionFlowCommand =
  | { type: 'merge_duplicate' }
  | { type: 'merge_all_duplicates' }
  | { type: 'keep_current' }
  | { type: 'keep_related' }
  | { type: 'keep_both' }
  | { type: 'accept_supersession' }
  | { type: 'reject_supersession' }
  | { type: 'skip' };

/**
 * Interface for conversation state storage.
 * Each platform has its own state storage.
 */
export interface IDecisionFlowStateRepository {
  saveAlertState(params: {
    tenantId: string;
    messageId: string;
    currentDecisionId: string;
    state: DecisionFlowConversationState;
    expiresAt: Date;
  }): Promise<void>;

  getAlertState(params: {
    tenantId: string;
    messageId: string;
  }): Promise<DecisionFlowConversationState | null>;

  deleteAlertState(params: {
    tenantId: string;
    messageId: string;
  }): Promise<void>;
}

/**
 * Manages multi-decision review state.
 */
export interface IMultiDecisionStateRepository {
  saveState(conversationId: string, state: MultiDecisionReviewState): Promise<void>;
  getState(conversationId: string): Promise<MultiDecisionReviewState | null>;
  deleteState(conversationId: string): Promise<void>;
}

/**
 * Manages conversation state for issue linking.
 */
export interface IConversationStateRepository {
  saveState(conversationId: string, state: unknown): Promise<void>;
  getState(conversationId: string): Promise<unknown | null>;
  deleteState(conversationId: string): Promise<void>;
}

/**
 * Interface for the decision flow service (alert orchestration + command handling).
 * Implemented by the hosted DecisionFlowService.
 */
export interface IDecisionFlowService {
  processIngestResponse(
    tenantId: string,
    response: IngestResponse,
    poster: MessagePoster,
    options?: { decisionTitle?: string; skipDecisionCard?: boolean }
  ): Promise<void>;
  executeCommand(
    tenantId: string,
    command: DecisionFlowCommand,
    state: DecisionFlowConversationState
  ): Promise<DecisionOperationResult>;
}

/**
 * Result of multi-decision flow command.
 */
export interface MultiDecisionFlowResult {
  handled: boolean;
  [key: string]: unknown;
}

/**
 * Interface for the multi-decision flow service (transcript review carousel).
 * Implemented by the hosted MultiDecisionFlowService.
 */
export interface IMultiDecisionFlowService {
  parseCommand(text: string): MultiDecisionCommand | null;
  handleCommand(
    context: PlatformContext,
    command: MultiDecisionCommand,
    stateRepo: IMultiDecisionStateRepository
  ): Promise<MultiDecisionFlowResult>;
}

/**
 * Interface for the conversation flow service (issue linking state machine).
 * Implemented by the hosted ConversationFlowService.
 */
export interface IConversationFlowService {
  setupInitialState(
    context: PlatformContext,
    response: IngestResponse,
    title: string
  ): Promise<void>;
  handleMessage(
    context: PlatformContext,
    text: string
  ): Promise<{ handled: boolean; action?: unknown }>;
}

export type ConnectorTier = TierConnectorTier;

export interface ConnectorCapabilities {
  tier: ConnectorTier;
  platform: DecisionPlatform;
  supportsTranscripts: boolean;
  supportsIssueCreation: boolean;
}

export interface TranscriptAnalysisResult {
  handled: boolean;
  decisions?: ExtractedDecision[];
  decisionCount?: number;
  error?: string;
}

export interface DecisionCaptureResult {
  handled: boolean;
  decisionId?: string;
  error?: string;
}

/**
 * No-op state repository for connectors that don't need interactive buttons.
 */
export class NoOpDecisionFlowStateRepository implements IDecisionFlowStateRepository {
  async saveAlertState(): Promise<void> {
    /* no-op */
  }
  async getAlertState(): Promise<null> {
    return null;
  }
  async deleteAlertState(): Promise<void> {
    /* no-op */
  }
}

/* -------------------------------------------------------------------------- */
/* Ambient capture                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A normalized conversation message used for decision analysis. Connector authors
 * map their platform's native messages into this shape.
 */
export interface ConversationItem {
  author?: string;
  content: string;
  platform: string;
  timestamp?: string;
}

/** The minimal decision shape a connector needs to render a capture confirmation. */
export interface DetectedDecision {
  title: string;
  summary: string;
  confidence: number;
  made_by?: string[];
}

/**
 * The kind of capture signal a connector emits:
 * - 'reaction'   an explicit emoji/react gesture (consent is implicit in the act)
 * - 'content'    a decision-shaped conversation detected in an opted-in resource
 * - 'publish'    a deliberate publish/review act (e.g. a published page)
 * - 'transition' a workflow state change the connector treats as a signal
 */
export type CaptureSignalKind = 'reaction' | 'content' | 'publish' | 'transition';

export interface CaptureSignal {
  kind: CaptureSignalKind;
  /** Resource the signal belongs to: channel / repo / space / project id. */
  resourceId: string;
  /** Conversation the signal belongs to: thread / issue / page id. */
  conversationId: string;
  userId?: string;
  items: ConversationItem[];
  sourceUrl: string;
}

/**
 * The universal, connector-agnostic capture contract. A connector implements this to
 * feed its NATURAL capture signal(s) into Align's hosted ambient-capture engine.
 *
 * This is an INTERFACE only. The engine that decides whether a signal becomes a capture
 * (entitlement, opt-in, decision-shape detection, analysis) is proprietary and lives in
 * Align's hosted platform - a connector author implements the interface; the hosted engine
 * calls it.
 */
export interface CaptureSignalAdapter {
  /** Connector key, e.g. 'slack' | 'teams' | 'jira' | 'confluence' | 'github'. */
  connectorKey: string;
  /** Map a raw platform event into a CaptureSignal, or null if it is not one. */
  detectSignal(event: unknown): Promise<CaptureSignal | null> | CaptureSignal | null;
  /**
   * Post the confirm gesture for a detected decision: an ephemeral message, adaptive
   * card, or comment with a capture/undo affordance. The connector owns the
   * platform-specific rendering.
   */
  postConfirm(signal: CaptureSignal, decisions: DetectedDecision[]): Promise<void>;
}

/** A no-op adapter: detects nothing, posts nothing. Useful as a default/test seam. */
export class NoOpCaptureSignalAdapter implements CaptureSignalAdapter {
  constructor(public readonly connectorKey: string) {}
  detectSignal(): null {
    return null;
  }
  async postConfirm(): Promise<void> {
    /* no-op */
  }
}
