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
