import { describe, expect, it } from 'vitest';
import { CommandParser, CommandHelpText } from '../parsers/CommandParser.js';
import type { Issue, RelatedDecision } from '../types/index.js';

describe('CommandParser.parse', () => {
  it('detects greetings', () => {
    for (const g of ['hi', 'Hello', 'hey', 'good morning', 'howdy', 'GREETINGS']) {
      expect(CommandParser.parse(g)).toEqual({ type: 'greeting' });
    }
  });

  it('detects help', () => {
    expect(CommandParser.parse('help')).toEqual({ type: 'help' });
    expect(CommandParser.parse('/help')).toEqual({ type: 'help' });
  });

  it('treats skip and acknowledge variants as skip', () => {
    for (const s of ['skip', 'please skip this', 'acknowledge', 'ack', 'ok']) {
      expect(CommandParser.parse(s)).toEqual({ type: 'skip' });
    }
  });

  describe('merge commands', () => {
    it('merge all', () => {
      expect(CommandParser.parse('merge all')).toEqual({ type: 'merge_all' });
    });
    it('merge with a single index (1-based -> 0-based)', () => {
      expect(CommandParser.parse('merge #2')).toEqual({ type: 'merge_single', index: 1 });
    });
    it('merge with multiple indices', () => {
      expect(CommandParser.parse('merge #1, #3')).toEqual({ type: 'merge_specific', indices: [0, 2] });
    });
    it('bare merge defaults to first duplicate', () => {
      expect(CommandParser.parse('merge')).toEqual({ type: 'merge_single', index: 0 });
    });
  });

  describe('keep / conflict commands', () => {
    it('keep both takes precedence', () => {
      expect(CommandParser.parse('keep both')).toEqual({ type: 'keep_both' });
    });
    it('keep new / keep a', () => {
      expect(CommandParser.parse('keep new')).toEqual({ type: 'keep_new' });
      expect(CommandParser.parse('keep a')).toEqual({ type: 'keep_new' });
    });
    it('keep old / keep b', () => {
      expect(CommandParser.parse('keep old')).toEqual({ type: 'keep_old' });
      expect(CommandParser.parse('keep b')).toEqual({ type: 'keep_old' });
    });
    it('unrecognized keep falls through to unknown', () => {
      expect(CommandParser.parse('keep something')).toEqual({ type: 'unknown' });
    });
  });

  describe('supersession commands', () => {
    it('accept supersession', () => {
      expect(CommandParser.parse('accept supersession')).toEqual({ type: 'accept_supersession' });
    });
    it('reject supersession', () => {
      expect(CommandParser.parse('reject supersession')).toEqual({ type: 'reject_supersession' });
    });
  });

  describe('create issue commands', () => {
    it('create new', () => {
      expect(CommandParser.parse('create new')).toEqual({ type: 'create_issue', projectKey: undefined });
    });
    it('create new in PROJECT extracts the key uppercased', () => {
      expect(CommandParser.parse('create new in abc')).toEqual({ type: 'create_issue', projectKey: 'ABC' });
    });
    it('create jira / linear', () => {
      expect(CommandParser.parse('create jira')).toMatchObject({ type: 'create_issue' });
      expect(CommandParser.parse('create linear')).toMatchObject({ type: 'create_issue' });
    });
  });

  describe('issue linking', () => {
    it('link with explicit issue key', () => {
      expect(CommandParser.parse('link to PROJ-123')).toEqual({ type: 'link_issue', issueKey: 'PROJ-123' });
    });
    it('a bare issue key links', () => {
      expect(CommandParser.parse('ABC-9')).toEqual({ type: 'link_issue', issueKey: 'ABC-9' });
    });
    it('an issue key buried in long prose does not auto-link', () => {
      const res = CommandParser.parse('I think the change described in PROJ-123 is wrong and needs discussion');
      expect(res).toEqual({ type: 'unknown' });
    });
  });

  it('returns unknown for unrecognized text', () => {
    expect(CommandParser.parse('what is the weather')).toEqual({ type: 'unknown' });
  });

  it('isGreeting matches greetings only', () => {
    expect(CommandParser.isGreeting('hello')).toBe(true);
    expect(CommandParser.isGreeting('merge')).toBe(false);
  });
});

describe('CommandHelpText', () => {
  it('returns per-context command lists', () => {
    expect(CommandHelpText.getDuplicateCommands().length).toBeGreaterThan(0);
    expect(CommandHelpText.getConflictCommands().join(' ')).toContain('keep');
    expect(CommandHelpText.getSupersessionCommands().join(' ')).toContain('supersession');
  });

  it('issue commands vary by connector', () => {
    const jira = CommandHelpText.getIssueCommands(['jira']).join(' ');
    expect(jira).toContain('create new');
    const linear = CommandHelpText.getIssueCommands(['linear']).join(' ');
    expect(linear).toContain('Linear');
  });

  it('getApplicableCommands assembles sections by relationship', () => {
    const related: RelatedDecision[] = [
      { relationship: 'duplicates' } as RelatedDecision,
      { relationship: 'conflicts_with' } as RelatedDecision,
      { relationship: 'supersedes' } as RelatedDecision,
    ];
    const issues: Issue[] = [];
    const out = CommandHelpText.getApplicableCommands(related, issues, ['jira']);
    const joined = out.join('\n');
    expect(joined).toContain('Duplicate Resolution');
    expect(joined).toContain('Conflict Resolution');
    expect(joined).toContain('Supersession');
    expect(joined).toContain('Issue Tracking');
  });

  it('getApplicableCommands always offers skip when no sections apply', () => {
    const out = CommandHelpText.getApplicableCommands([], [], []);
    expect(out.join('\n')).toContain('skip');
  });

  it('format helpers join with newlines', () => {
    expect(CommandHelpText.formatForSlack(['a', 'b'])).toBe('a\nb');
    expect(CommandHelpText.formatForTeams(['a', 'b'])).toBe('a\nb');
  });
});
