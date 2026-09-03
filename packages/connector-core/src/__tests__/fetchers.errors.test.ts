/**
 * One rule for a refused provider request, every fetcher: say what the provider said,
 * and point at the token only when the status means the credential was refused.
 *
 * Until 2026-09-03 four fetchers said "check your token" for ANY non-OK status, so a
 * Linear 400 (a rejected request) sent a user chasing a token that was fine. ALI-169 had
 * already decided every fetcher throws a typed auth error on 401 so the CLI's reconnect
 * logic works uniformly; the text guesses crept back in after it.
 */
import { describe, expect, it } from 'vitest';
import { FetcherAuthError, providerError, providerErrorText } from '../fetchers/errors.js';

const res = (status: number, body: unknown, opts: { textOnly?: boolean; jsonOnly?: boolean } = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: false,
    status,
    ...(opts.jsonOnly ? {} : { text: async () => text }),
    ...(opts.textOnly ? {} : { json: async () => (typeof body === 'string' ? JSON.parse(body) : body) }),
  };
};

describe('providerErrorText reads the provider\'s own words from whichever shape it uses', () => {
  it.each([
    ['GitHub / GitLab / Notion: top-level message', { message: 'Bad credentials' }, 'Bad credentials'],
    ['Linear / GraphQL: errors[].message', { errors: [{ message: 'Authentication required' }, { message: 'and more' }] }, 'Authentication required; and more'],
    ['Microsoft Graph: error.message', { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } }, 'Access token has expired.'],
    ['Atlassian: errorMessages[]', { errorMessages: ['Client must be authenticated to access this resource.'] }, 'Client must be authenticated to access this resource.'],
    ['a plain error string', { error: 'invalid_token' }, 'invalid_token'],
    ['not JSON at all', '<html>502 Bad Gateway</html>', '<html>502 Bad Gateway</html>'],
  ])('%s', async (_label, body, expected) => {
    expect(await providerErrorText(res(500, body))).toBe(expected);
  });

  it('returns an empty string when the body is empty, never the word null', async () => {
    expect(await providerErrorText(res(500, ''))).toBe('');
    expect(await providerErrorText(res(500, null as unknown as string))).toBe('');
  });

  it('truncates a long body so a stack trace does not become the error message', async () => {
    const text = await providerErrorText(res(500, 'x'.repeat(1000)));
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('reads a response that only offers json(), as some test doubles do', async () => {
    expect(await providerErrorText(res(500, { message: 'from json' }, { jsonOnly: true }))).toBe('from json');
  });
});

describe('providerError maps the status to the error a caller can act on', () => {
  it('401 is a typed FetcherAuthError carrying the provider text', async () => {
    const err = await providerError('GitHub', res(401, { message: 'Bad credentials' }));
    expect(err).toBeInstanceOf(FetcherAuthError);
    expect((err as FetcherAuthError).connector).toBe('GitHub');
    expect(err.message).toMatch(/GitHub authentication failed \(401\): Bad credentials/);
    expect(err.message).toMatch(/token/i);
  });

  it('a non-401 status is a plain Error with the provider text and no token hint', async () => {
    const err = await providerError('Linear', res(400, { errors: [{ message: 'Variable "$first" got invalid value' }] }));
    expect(err).not.toBeInstanceOf(FetcherAuthError);
    expect(err.message).toBe('Linear API failed (400): Variable "$first" got invalid value.');
    expect(err.message).not.toMatch(/token/i);
  });

  it('403 adds the connector\'s own scope hint after the provider text, and 500 does not', async () => {
    const forbidden = 'Check the token has the read_api scope.';
    const e403 = await providerError('GitLab', res(403, { message: '403 Forbidden' }), { forbidden });
    expect(e403.message).toBe('GitLab API failed (403): 403 Forbidden. Check the token has the read_api scope.');
    const e500 = await providerError('GitLab', res(500, { message: 'boom' }), { forbidden });
    expect(e500.message).toBe('GitLab API failed (500): boom.');
  });

  it('with no provider text the message still names the status and nothing else', async () => {
    expect((await providerError('Notion', res(502, ''))).message).toBe('Notion API failed (502).');
    expect((await providerError('Notion', res(401, ''))).message).toMatch(/^Notion authentication failed \(401\)\. /);
  });
});
