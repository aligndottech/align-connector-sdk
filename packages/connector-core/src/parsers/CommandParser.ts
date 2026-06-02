/**
 * Shared command parser for communication connectors (Slack, Teams, etc.)
 * This ensures consistent command handling across all platforms.
 */

import type { CommandAction, Issue, RelatedDecision } from '../types/index.js';

/**
 * Patterns for detecting greetings
 */
const GREETING_PATTERNS = /^(hi|hello|hey|sup|yo|good\s*(morning|afternoon|evening)|howdy|hiya|greetings)$/i;

/**
 * Parse user command text into standardized action
 */
export class CommandParser {
  /**
   * Parse user text into a standardized command action
   */
  static parse(text: string): CommandAction {
    const trimmedText = text.trim();
    const lowerText = trimmedText.toLowerCase();

    // Greeting detection (should reset conversation)
    if (GREETING_PATTERNS.test(trimmedText)) {
      return { type: 'greeting' };
    }

    // Help command
    if (lowerText === 'help' || lowerText === '/help') {
      return { type: 'help' };
    }

    // Skip command
    if (lowerText === 'skip' || lowerText.includes('skip')) {
      return { type: 'skip' };
    }

    // Acknowledge command (for non-conflict relationships like relates/refines)
    if (lowerText === 'acknowledge' || lowerText === 'ack' || lowerText === 'ok') {
      return { type: 'skip' }; // Acknowledge is functionally the same as skip - move to next
    }

    // Merge commands
    if (lowerText.includes('merge')) {
      return this.parseMergeCommand(text, lowerText);
    }

    // Conflict resolution commands
    if (lowerText.includes('keep')) {
      const keepAction = this.parseKeepCommand(lowerText);
      if (keepAction) return keepAction;
    }

    // Supersession commands
    if (lowerText.includes('supersession')) {
      const supersessionAction = this.parseSupersessionCommand(lowerText);
      if (supersessionAction) return supersessionAction;
    }

    // Create new issue command
    // Supports: "create new", "create jira", "create linear", "create new in PROJECT", "create in PROJECT"
    if (lowerText.includes('create') && (lowerText.includes('new') || lowerText.includes('jira') || lowerText.includes('linear') || lowerText.includes(' in '))) {
      return this.parseCreateCommand(text);
    }

    // Link to issue command
    const issueKeyMatch = text.match(/\b[A-Z]+-\d+\b/);
    if (lowerText.includes('link') && issueKeyMatch) {
      return { type: 'link_issue', issueKey: issueKeyMatch[0] };
    }

    // Also allow just typing an issue key to link
    if (issueKeyMatch && !lowerText.includes('create')) {
      // Check if the message is primarily just an issue key reference
      const cleanText = trimmedText.replace(/\b[A-Z]+-\d+\b/g, '').trim();
      if (cleanText.length < 10 || lowerText.includes('link')) {
        return { type: 'link_issue', issueKey: issueKeyMatch[0] };
      }
    }

    return { type: 'unknown' };
  }

  /**
   * Parse merge-related commands
   */
  private static parseMergeCommand(text: string, lowerText: string): CommandAction {
    const indexMatches = text.match(/#(\d+)/g);

    if (lowerText.includes('merge all')) {
      return { type: 'merge_all' };
    }

    if (indexMatches && indexMatches.length > 1) {
      // Merge with multiple specific indices: "merge #1, #2"
      const indices = indexMatches.map(m => parseInt(m.substring(1)) - 1);
      return { type: 'merge_specific', indices };
    }

    if (indexMatches && indexMatches.length === 1) {
      // Merge with specific index: "merge #1" or "merge with #2"
      const index = parseInt(indexMatches[0].substring(1)) - 1;
      return { type: 'merge_single', index };
    }

    // Default: merge with first duplicate
    return { type: 'merge_single', index: 0 };
  }

  /**
   * Parse keep commands for conflict resolution
   * Note: Order matters - check "both" first since "keep b" would otherwise match "keep_old"
   */
  private static parseKeepCommand(lowerText: string): CommandAction | null {
    // Check "both" first - it's the most specific
    if (lowerText.includes('both')) {
      return { type: 'keep_both' };
    }
    if (lowerText.includes('new') || lowerText === 'keep a') {
      return { type: 'keep_new' };
    }
    if (lowerText.includes('old') || lowerText === 'keep b') {
      return { type: 'keep_old' };
    }
    return null;
  }

  /**
   * Parse supersession commands
   */
  private static parseSupersessionCommand(lowerText: string): CommandAction | null {
    if (lowerText.includes('accept')) {
      return { type: 'accept_supersession' };
    }
    if (lowerText.includes('reject')) {
      return { type: 'reject_supersession' };
    }
    return null;
  }

  /**
   * Parse create issue command, extracting optional project key
   */
  private static parseCreateCommand(text: string): CommandAction {
    // Check for "create new in PROJECT-KEY" pattern
    const projectMatch = text.match(/create\s+(?:new\s+)?in\s+([A-Z][A-Z0-9]+)/i);
    const projectKey = projectMatch ? projectMatch[1].toUpperCase() : undefined;
    return { type: 'create_issue', projectKey };
  }

  /**
   * Check if text is a greeting
   */
  static isGreeting(text: string): boolean {
    return GREETING_PATTERNS.test(text.trim());
  }
}

/**
 * Generate command help text for different scenarios
 */
export class CommandHelpText {
  /**
   * Get command list for duplicate decisions
   */
  static getDuplicateCommands(): string[] {
    return [
      '`merge` - Merge with first duplicate',
      '`merge all` - Merge with all duplicates',
      '`merge #1, #2` - Merge with specific duplicates',
    ];
  }

  /**
   * Get command list for conflicting decisions
   */
  static getConflictCommands(): string[] {
    return [
      '`keep new` (or `keep a`) - Keep new decision, archive conflicting one',
      '`keep old` (or `keep b`) - Keep old decision, archive new one',
      '`keep both` - Keep both decisions as separate',
    ];
  }

  /**
   * Get command list for supersession decisions
   */
  static getSupersessionCommands(): string[] {
    return [
      '`accept supersession` - Archive old decision, keep new one',
      '`reject supersession` - Keep old decision active',
    ];
  }

  /**
   * Get command list for JIRA/Linear issue linking
   */
  static getIssueCommands(connectors: string[] = ['jira']): string[] {
    const commands: string[] = [];

    if (connectors.includes('jira') || connectors.includes('linear')) {
      commands.push('`link to PROJ-123` - Link to existing issue');
    }

    if (connectors.includes('jira')) {
      commands.push('`create new` - Create new JIRA issue');
      commands.push('`create new in PROJ` - Create in specific project');
    }

    if (connectors.includes('linear')) {
      commands.push('`create linear` - Create new Linear issue');
    }

    commands.push('`skip` - Continue without linking');

    return commands;
  }

  /**
   * Get all applicable commands for a given context
   */
  static getApplicableCommands(
    relatedDecisions: RelatedDecision[],
    issues: Issue[],
    enabledConnectors: string[] = ['jira']
  ): string[] {
    const commands: string[] = [];

    const hasDuplicates = relatedDecisions.some(d => d.relationship === 'duplicates');
    const hasConflicts = relatedDecisions.some(d => d.relationship === 'conflicts_with');
    const hasSupersessions = relatedDecisions.some(d => d.relationship === 'supersedes');

    if (hasDuplicates) {
      commands.push('**Duplicate Resolution:**');
      commands.push(...this.getDuplicateCommands().map(c => `  ${c}`));
    }

    if (hasConflicts) {
      commands.push('**Conflict Resolution:**');
      commands.push(...this.getConflictCommands().map(c => `  ${c}`));
    }

    if (hasSupersessions) {
      commands.push('**Supersession:**');
      commands.push(...this.getSupersessionCommands().map(c => `  ${c}`));
    }

    // Issue commands
    const hasIssueConnectors = enabledConnectors.some(c => ['jira', 'linear'].includes(c));
    if (hasIssueConnectors) {
      commands.push('**Issue Tracking:**');
      commands.push(...this.getIssueCommands(enabledConnectors).map(c => `  ${c}`));
    }

    // Always include skip
    if (!commands.some(c => c.includes('skip'))) {
      commands.push('`skip` - Skip this step');
    }

    return commands;
  }

  /**
   * Format commands for Slack (uses backticks and bold)
   */
  static formatForSlack(commands: string[]): string {
    return commands.join('\n');
  }

  /**
   * Format commands for Teams (uses ** for bold)
   */
  static formatForTeams(commands: string[]): string {
    return commands.join('\n');
  }
}
