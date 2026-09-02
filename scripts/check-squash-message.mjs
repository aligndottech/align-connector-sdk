#!/usr/bin/env node
/**
 * Fail a PR whose squash commit release-please cannot parse.
 *
 * This repo squash-merges with the PR title as the subject (or the single
 * commit's subject when the branch holds one commit) and the branch's commit
 * messages concatenated as the body. release-please feeds that whole message to
 * the conventional-commits parser, and a body line it cannot parse discards the
 * ENTIRE commit: "commits: 0 ... skipping", no release PR, no changelog line, and
 * nothing red anywhere. That stranded align-connector-sdk #26 (a body line that
 * began with a backtick and a parenthesis) and align-cli #202 before it (a
 * subject the parser of the day rejected). The fix both times was a follow-up
 * PR whose clean subject carried the changelog line in place of the lost one.
 * This guard is the third time not happening: it runs the same parser package
 * release-please bundles, pinned, over the same message.
 *
 * Usage: node scripts/check-squash-message.mjs <base-ref> <head-ref>
 *   PR_TITLE   the pull request title (GitHub uses it when the branch has >1 commit)
 *   PR_NUMBER  optional; appended as " (#N)" the way GitHub does
 */
import { execFileSync } from 'node:child_process';
import { parser } from '@conventional-commits/parser';

export function composeSquashMessage({ commits, prTitle, prNumber }) {
  // Mirrors GitHub's COMMIT_OR_PR_TITLE + COMMIT_MESSAGES squash settings.
  const subject = commits.length === 1 ? commits[0].subject : prTitle;
  const suffix = prNumber ? ` (#${prNumber})` : '';
  const body = commits.map((c) => (c.body ? `* ${c.subject}\n\n${c.body}` : `* ${c.subject}`)).join('\n\n');
  return `${subject}${suffix}\n\n${body}\n`;
}

/** Returns null when the message parses, otherwise the parser's error message. */
export function parseFailure(message) {
  try {
    parser(message);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function commitsBetween(base, head) {
  const raw = execFileSync('git', ['log', '--reverse', '--format=%H%x00%s%x00%b%x1e', `${base}..${head}`], { encoding: 'utf8' });
  return raw
    .split('\x1e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter((rec) => rec.trim() !== '')
    .map((rec) => {
      const [sha, subject, body] = rec.split('\x00');
      return { sha, subject, body: (body ?? '').trim() };
    });
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error('usage: check-squash-message.mjs <base-ref> <head-ref>');
    process.exit(2);
  }
  const commits = commitsBetween(base, head);
  if (commits.length === 0) {
    // An empty range is a broken invocation, never a pass: a guard that examined
    // nothing must not report green.
    console.error(`no commits in ${base}..${head}; the guard examined nothing`);
    process.exit(2);
  }
  const prTitle = process.env.PR_TITLE ?? commits[commits.length - 1].subject;
  const message = composeSquashMessage({ commits, prTitle, prNumber: process.env.PR_NUMBER });
  const failure = parseFailure(message);
  if (failure) {
    const at = /at (\d+):(\d+)/.exec(failure);
    const line = at ? message.split('\n')[Number(at[1]) - 1] : undefined;
    console.error('The squash commit release-please will see does not parse as a conventional commit.');
    console.error(`  parser: ${failure}`);
    if (line !== undefined) console.error(`  line ${at[1]}: ${JSON.stringify(line)}`);
    console.error('Every line of every commit message on the branch ends up in that squash body.');
    console.error('Reword the commit (git commit --amend or rebase) so the line parses; a commit');
    console.error('release-please cannot parse is silently dropped from the release and the changelog.');
    process.exit(1);
  }
  console.log(`squash message parses (${commits.length} commit(s), subject: ${message.split('\n')[0]})`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
