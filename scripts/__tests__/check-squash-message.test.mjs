import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSquashMessage, parseFailure } from '../check-squash-message.mjs';

const clean = [
  { subject: 'feat(fetchers): one clean commit (ALI-1)', body: 'A body in prose.\n\nCo-Authored-By: Someone <s@example.test>' },
];

test('a clean single-commit branch composes the commit subject and parses', () => {
  const msg = composeSquashMessage({ commits: clean, prTitle: 'ignored for one commit', prNumber: '27' });
  assert.equal(msg.split('\n')[0], 'feat(fetchers): one clean commit (ALI-1) (#27)');
  assert.equal(parseFailure(msg), null);
});

test('a multi-commit branch takes the PR title as the subject', () => {
  const msg = composeSquashMessage({ commits: [...clean, ...clean], prTitle: 'fix(x): the pr title', prNumber: '27' });
  assert.equal(msg.split('\n')[0], 'fix(x): the pr title (#27)');
  assert.equal(parseFailure(msg), null);
});

test('the body line that stranded #26 is caught, naming its position', () => {
  // The negative control: the exact shape release-please rejected on 3089bf8.
  const commits = [
    { subject: 'feat(fetchers): fetch reports on the contract', body: 'Where both exist, fetch returns exactly\n`(await fetchWithReport()).items`, one implementation behind two entry\npoints.' },
  ];
  const failure = parseFailure(composeSquashMessage({ commits, prTitle: 'x', prNumber: '26' }));
  assert.match(failure ?? '', /unexpected token/);
});

test('a non-conventional subject is caught', () => {
  assert.notEqual(parseFailure(composeSquashMessage({ commits: [{ subject: 'update stuff', body: '' }], prTitle: 'x' })), null);
});
