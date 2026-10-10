import { describe, expect, it, vi } from 'vitest';
import {
  REDACT_CONTENT_KEY_PATTERNS,
  REDACT_QUERY_PARAM_PATTERNS,
  REDACT_VALUE_KEY_PATTERNS,
  RedactingSpanProcessor,
  redactSpanAttributes,
  redactSqlStatement,
  redactUrlCredentials,
} from '../spanRedaction.js';

describe('redactSpanAttributes', () => {
  it('redacts credential-bearing attribute keys', () => {
    const out = redactSpanAttributes({
      'http.request.header.authorization': 'Bearer secret-token',
      'http.response.header.set-cookie': 'session=abc; HttpOnly',
      'db.user.password': 'hunter2',
      'connector.api_key': 'sk-12345',
      'x.access_token': 'ya29.aaa',
    });
    expect(out['http.request.header.authorization']).toBe('[REDACTED]');
    expect(out['http.response.header.set-cookie']).toBe('[REDACTED]');
    expect(out['db.user.password']).toBe('[REDACTED]');
    expect(out['connector.api_key']).toBe('[REDACTED]');
    expect(out['x.access_token']).toBe('[REDACTED]');
  });

  it('matches keys case-insensitively', () => {
    const out = redactSpanAttributes({ 'HTTP.Request.Header.Authorization': 'Bearer x' });
    expect(out['HTTP.Request.Header.Authorization']).toBe('[REDACTED]');
  });

  it('redacts content/body attributes that could carry decision text', () => {
    const out = redactSpanAttributes({
      'http.request.body': '{"decision":"ship it"}',
      'http.response.body': 'big payload',
      'decision.content': 'we will migrate to X',
    });
    expect(out['http.request.body']).toBe('[REDACTED]');
    expect(out['http.response.body']).toBe('[REDACTED]');
    expect(out['decision.content']).toBe('[REDACTED]');
  });

  it('leaves benign telemetry attributes untouched', () => {
    const input = {
      'http.method': 'GET',
      'http.status_code': 200,
      'db.system': 'postgresql',
      'net.peer.name': 'rds.internal',
    };
    expect(redactSpanAttributes(input)).toEqual(input);
  });

  it('scrubs literals inside db.statement', () => {
    const out = redactSpanAttributes({
      'db.statement': "SELECT * FROM users WHERE email = 'tom@align.tech' AND age = 42",
    });
    expect(out['db.statement']).toBe("SELECT * FROM users WHERE email = '?' AND age = ?");
  });

  it('does not crash on non-string attribute values', () => {
    const out = redactSpanAttributes({
      'http.status_code': 200,
      'flags': [true, false],
      'authorization': 12345,
    });
    expect(out['http.status_code']).toBe(200);
    expect(out['authorization']).toBe('[REDACTED]');
  });
});

describe('redactSqlStatement', () => {
  it('preserves parameterized queries (no inline literals, keeps $N placeholders)', () => {
    const sql = 'SELECT encrypted_value FROM oauth_tokens WHERE tenant_id=$1 AND connector_key=$2';
    expect(redactSqlStatement(sql)).toBe(sql);
  });

  it('replaces single-quoted string literals with \'?\'', () => {
    expect(redactSqlStatement("INSERT INTO t (name) VALUES ('Alice')"))
      .toBe("INSERT INTO t (name) VALUES ('?')");
  });

  it('replaces numeric literals but not $N placeholders', () => {
    expect(redactSqlStatement('UPDATE t SET n = 99 WHERE id = $1'))
      .toBe('UPDATE t SET n = ? WHERE id = $1');
  });

  it('handles escaped quotes inside string literals', () => {
    expect(redactSqlStatement("SELECT 'it''s fine' AS x")).toBe("SELECT '?' AS x");
  });
});

describe('redactUrlCredentials (ALI-1178)', () => {
  it('redacts the VALUE of a credential-named query parameter, keeping the rest of the URL', () => {
    expect(redactUrlCredentials('https://zoom.us/rec/download/abc?access_token=SECRET')).toBe(
      'https://zoom.us/rec/download/abc?access_token=[REDACTED]',
    );
  });

  it('keeps benign query parameters alongside the redacted one', () => {
    expect(
      redactUrlCredentials('https://api.zoom.us/v2/x?meetingId=99&access_token=SECRET&format=vtt'),
    ).toBe('https://api.zoom.us/v2/x?meetingId=99&access_token=[REDACTED]&format=vtt');
  });

  it('returns a URL with no credential parameter byte-identical (positive control)', () => {
    const url = 'https://api.zoom.us/v2/meetings/99/recordings?page_size=30&format=vtt';
    expect(redactUrlCredentials(url)).toBe(url);
  });

  it('leaves a string that is not URL-shaped alone, even when it looks like a query', () => {
    expect(redactUrlCredentials('SELECT 1')).toBe('SELECT 1');
    expect(redactUrlCredentials('some prose mentioning ?access_token=x')).toBe(
      'some prose mentioning ?access_token=x',
    );
  });

  it('redacts the whole userinfo component, keeping the host', () => {
    expect(redactUrlCredentials('https://user:pass@git.example.com/repo.git')).toBe(
      'https://[REDACTED]@git.example.com/repo.git',
    );
    expect(redactUrlCredentials('https://ghp_abcdef123@github.com/o/r.git')).toBe(
      'https://[REDACTED]@github.com/o/r.git',
    );
  });

  it('does not throw on malformed or partial URLs', () => {
    const malformed = [
      'https://',
      'https://%%%?token=x',
      'http://?token=x',
      'https://h/p?',
      'https://h/p?flagonly',
      'https://h/p?token',
      '://nohost?token=x',
      'https://a@b@c/p?token=x',
    ];
    for (const value of malformed) {
      expect(() => redactUrlCredentials(value)).not.toThrow();
    }
    expect(redactUrlCredentials('http://?token=x')).toBe('http://?token=[REDACTED]');
  });
});

describe('redactSpanAttributes URL handling (ALI-1178)', () => {
  it('scrubs credential params under the http.url key', () => {
    const out = redactSpanAttributes({
      'http.url': 'https://zoom.us/rec/download/abc?access_token=SECRET',
      'http.method': 'GET',
    });
    expect(out['http.url']).toBe('https://zoom.us/rec/download/abc?access_token=[REDACTED]');
    expect(out['http.method']).toBe('GET');
  });

  it('scrubs credential params under url.full, the newer semantic-convention key', () => {
    const out = redactSpanAttributes({
      'url.full': 'https://zoom.us/rec/download/abc?access_token=SECRET',
    });
    expect(out['url.full']).toBe('https://zoom.us/rec/download/abc?access_token=[REDACTED]');
  });

  it('scrubs a URL under an arbitrary key, since the scan is value-shaped not key-listed', () => {
    const out = redactSpanAttributes({
      'connector.download_target': 'https://zoom.us/rec/x?access_token=SECRET',
    });
    expect(out['connector.download_target']).toBe(
      'https://zoom.us/rec/x?access_token=[REDACTED]',
    );
  });

  it('leaves a URL with no credential parameter byte-identical', () => {
    const input = { 'http.url': 'https://api.zoom.us/v2/users/me?page_size=30' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });

  it('still redacts the whole value when the KEY itself is credential-named', () => {
    const out = redactSpanAttributes({ 'x.access_token': 'https://h/p?page_size=30' });
    expect(out['x.access_token']).toBe('[REDACTED]');
  });

  it('does not treat db.statement as a URL', () => {
    const out = redactSpanAttributes({
      'db.statement': "SELECT * FROM t WHERE u = 'https://h/p?access_token=x'",
    });
    expect(out['db.statement']).toBe("SELECT * FROM t WHERE u = '?'");
  });
});

describe('the query-parameter list is separate from the attribute-KEY list (ALI-1188)', () => {
  it.each([
    ['http.status_code', 200],
    ['http.response.status_code', '404'],
    ['error.code', 'ETIMEDOUT'],
  ])('leaves the attribute key %s readable', (key, value) => {
    expect(redactSpanAttributes({ [key]: value })).toEqual({ [key]: value });
  });
});

describe('query-parameter names reach URL-shaped values too (ALI-1188)', () => {
  it('redacts ?code=, which the attribute-key list could never reach', () => {
    expect(redactUrlCredentials('https://id.example.com/cb?code=AUTHCODE&foo=1')).toBe(
      'https://id.example.com/cb?code=[REDACTED]&foo=1',
    );
  });

  it('redacts ?state=', () => {
    expect(redactUrlCredentials('https://id.example.com/cb?state=CSRFNONCE')).toBe(
      'https://id.example.com/cb?state=[REDACTED]',
    );
  });

  it('still redacts ?access_token=, inherited from the key list (ALI-1178 non-regression)', () => {
    expect(redactUrlCredentials('https://zoom.us/rec/x?access_token=SECRET')).toBe(
      'https://zoom.us/rec/x?access_token=[REDACTED]',
    );
  });
});

describe('url.query carrier (ALI-1188)', () => {
  it('redacts the undici shape, which keeps the leading ? (the LIVE writer)', () => {
    expect(
      redactSpanAttributes({ 'url.query': '?code=AUTHCODE&state=CSRFNONCE' })['url.query'],
    ).toBe('?code=[REDACTED]&state=[REDACTED]');
  });

  it('returns an undici-shape query with no credential byte-identical (positive control)', () => {
    const input = { 'url.query': '?page_size=30&format=vtt' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });

  it('redacts every credential-named parameter in a bare query string', () => {
    expect(redactSpanAttributes({ 'url.query': 'code=AUTHCODE&state=CSRFNONCE' })['url.query']).toBe(
      'code=[REDACTED]&state=[REDACTED]',
    );
  });

  it('keeps benign parameters alongside the redacted one', () => {
    expect(redactSpanAttributes({ 'url.query': 'code=AUTHCODE&format=vtt' })['url.query']).toBe(
      'code=[REDACTED]&format=vtt',
    );
  });

  it('returns a query carrying no credential byte-identical (positive control)', () => {
    const input = { 'url.query': 'page_size=30&format=vtt' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });
});

describe('http.target carrier (ALI-1188)', () => {
  it('redacts the query while keeping the path', () => {
    const out = redactSpanAttributes({
      'http.target': '/oauth/callback/slack?code=AUTHCODE&state=CSRFNONCE',
    });
    expect(out['http.target']).toBe('/oauth/callback/slack?code=[REDACTED]&state=[REDACTED]');
  });

  it('redacts an inherited credential name on the same carrier', () => {
    const out = redactSpanAttributes({ 'http.target': '/api/v1/x?access_token=SECRET&page=2' });
    expect(out['http.target']).toBe('/api/v1/x?access_token=[REDACTED]&page=2');
  });

  it('leaves a path with no query byte-identical', () => {
    const input = { 'http.target': '/health' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });

  it('leaves a query carrying no credential byte-identical', () => {
    const input = { 'http.target': '/api/x?page=2&sort=asc' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });
});

describe('the two carrier defects, each with its positive control (ALI-1188 follow-up)', () => {
  it('redacts a shared secret arriving as ?hmac= on http.target', () => {
    expect(
      redactSpanAttributes({ 'http.target': '/webhook/jira?hmac=SHAREDSECRET' })['http.target'],
    ).toBe('/webhook/jira?hmac=[REDACTED]');
    expect(
      redactSpanAttributes({ 'http.target': '/webhook/jira?secret=SHAREDSECRET' })['http.target'],
    ).toBe('/webhook/jira?secret=[REDACTED]');
  });

  it('redacts the undici url.query shape, which keeps the leading ?', () => {
    expect(
      redactSpanAttributes({ 'url.query': '?code=AUTHCODE&state=NONCE' })['url.query'],
    ).toBe('?code=[REDACTED]&state=[REDACTED]');
    expect(redactSpanAttributes({ 'url.query': 'code=AUTHCODE&state=NONCE' })['url.query']).toBe(
      'code=[REDACTED]&state=[REDACTED]',
    );
  });

  it('normalising the ? does not regress the inherited unanchored patterns', () => {
    expect(redactSpanAttributes({ 'url.query': '?access_token=SECRET' })['url.query']).toBe(
      '?access_token=[REDACTED]',
    );
    expect(redactSpanAttributes({ 'url.query': 'access_token=SECRET' })['url.query']).toBe(
      'access_token=[REDACTED]',
    );
  });

  it('redacts a benign-looking ?state= producer, a deliberate cost', () => {
    expect(
      redactSpanAttributes({ 'url.query': '?state=all&per_page=100' })['url.query'],
    ).toBe('?state=[REDACTED]&per_page=100');
  });
});

describe('the carrier set is a NAME list, not a shape sniff (ALI-1188)', () => {
  it('does not scrub an arbitrary attribute whose value merely looks like a query', () => {
    const input = { 'my.custom.attr': 'code=AUTHCODE' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });
});

describe('query-parameter names, each with its anchoring control (ALI-1188)', () => {
  it.each([
    ['code', 'AUTHCODE'],
    ['state', 'CSRFNONCE'],
    ['sig', 'SIGVALUE'],
    ['signature', 'SIGVALUE'],
    ['X-Amz-Signature', 'SIGVALUE'],
    ['auth', 'BEARERISH'],
    ['code_verifier', 'PKCESECRET'],
    ['pwd', 'ZOOMPASSCODE'],
    ['hmac', 'SHAREDSECRET'],
  ])('redacts ?%s= under BOTH url.query writer shapes', (name, value) => {
    expect(redactSpanAttributes({ 'url.query': `${name}=${value}` })['url.query']).toBe(
      `${name}=[REDACTED]`,
    );
    expect(redactSpanAttributes({ 'url.query': `?${name}=${value}` })['url.query']).toBe(
      `?${name}=[REDACTED]`,
    );
  });

  it.each([
    ['error_code', '404'],
    ['country_code', 'GB'],
    ['us_state', 'CA'],
    ['assignee', 'bob'],
    ['design', 'flat'],
    ['signature_version', '4'],
    ['oauth_version', '2'],
    ['code_challenge', 'PUBLICHASH'],
    ['state_filter', 'open'],
    ['code_verifier_method', 'S256'],
    ['x_code_verifier', 'NOTTHEONE'],
    ['auth_type', 'basic'],
    ['oauth', 'v2'],
  ])('keeps ?%s= readable under BOTH url.query writer shapes', (name, value) => {
    const query = `${name}=${value}`;
    expect(redactSpanAttributes({ 'url.query': query })['url.query']).toBe(query);
    expect(redactSpanAttributes({ 'url.query': `?${query}` })['url.query']).toBe(`?${query}`);
  });
});

describe('carrier redaction cannot throw or mangle (ALI-1188)', () => {
  it('does not throw on malformed carrier values, and returns them byte-identical', () => {
    const unchanged = ['', '=', '&&&', '?', '%%%', 'a=b=c', 'code', '?&='];
    for (const value of unchanged) {
      expect(redactSpanAttributes({ 'url.query': value })['url.query']).toBe(value);
      expect(redactSpanAttributes({ 'http.target': value })['http.target']).toBe(value);
    }
    expect(redactSpanAttributes({ 'url.query': '&code=x&' })['url.query']).toBe(
      '&code=[REDACTED]&',
    );
    expect(redactSpanAttributes({ 'url.query': '?code=x&' })['url.query']).toBe(
      '?code=[REDACTED]&',
    );
  });

  it('splits on the FIRST = so a credential value containing = is still redacted whole', () => {
    expect(redactSpanAttributes({ 'url.query': 'code=a=b' })['url.query']).toBe('code=[REDACTED]');
  });

  it('passes a non-string value under a carrier key through untouched', () => {
    const input = { 'url.query': 42, 'http.target': true };
    expect(redactSpanAttributes(input)).toEqual(input);
  });
});

describe('branch order in redactSpanAttributes (ALI-1178 non-regression, ALI-1188)', () => {
  it('the credential-KEY branch still runs before the string branch', () => {
    expect(
      redactSpanAttributes({ 'x.access_token': 'https://h/p?access_token=SECRET' })[
        'x.access_token'
      ],
    ).toBe('[REDACTED]');
  });

  it('db.statement is still SQL-scrubbed rather than query-scrubbed', () => {
    const out = redactSpanAttributes({
      'db.statement': "SELECT * FROM t WHERE q = 'code=AUTHCODE'",
    });
    expect(out['db.statement']).toBe("SELECT * FROM t WHERE q = '?'");
  });

  it('the generic string branch still scrubs a URL under http.url', () => {
    const out = redactSpanAttributes({ 'http.url': 'https://zoom.us/rec/x?access_token=SECRET' });
    expect(out['http.url']).toBe('https://zoom.us/rec/x?access_token=[REDACTED]');
  });
});

describe('RedactingSpanProcessor', () => {
  function fakeDelegate() {
    return {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('redacts span attributes in onEnd, then delegates', () => {
    const delegate = fakeDelegate();
    const proc = new RedactingSpanProcessor(delegate as never);
    const span = { attributes: { authorization: 'Bearer x', 'http.method': 'POST' } };

    proc.onEnd(span as never);

    expect(span.attributes.authorization).toBe('[REDACTED]');
    expect(span.attributes['http.method']).toBe('POST');
    expect(delegate.onEnd).toHaveBeenCalledWith(span);
  });

  it('delegates onStart, forceFlush and shutdown', async () => {
    const delegate = fakeDelegate();
    const proc = new RedactingSpanProcessor(delegate as never);

    proc.onStart({} as never, {} as never);
    await proc.forceFlush();
    await proc.shutdown();

    expect(delegate.onStart).toHaveBeenCalledOnce();
    expect(delegate.forceFlush).toHaveBeenCalledOnce();
    expect(delegate.shutdown).toHaveBeenCalledOnce();
  });
});

describe('carrier values that are themselves URL-shaped delegate to redactUrlCredentials (ALI-1190)', () => {
  it('scrubs userinfo in a URL-shaped url.query value, which the bare-query logic cannot see', () => {
    const out = redactSpanAttributes({
      'url.query': 'https://user:pass@id.example.com/cb?code=AUTHCODE',
    });
    expect(out['url.query']).toBe('https://[REDACTED]@id.example.com/cb?code=[REDACTED]');
  });

  it('does the same for http.target, in case an instrumentation version populates it with a full URL', () => {
    const out = redactSpanAttributes({
      'http.target': 'https://user:pass@id.example.com/cb?code=AUTHCODE',
    });
    expect(out['http.target']).toBe('https://[REDACTED]@id.example.com/cb?code=[REDACTED]');
  });

  it('returns a URL-shaped carrier value with no credential byte-identical (positive control)', () => {
    const input = { 'url.query': 'https://id.example.com/cb?page=2' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });

  it('leaves a non-URL-shaped carrier value on the ordinary bare-query path', () => {
    const out = redactSpanAttributes({ 'url.query': 'code=AUTHCODE&format=vtt' });
    expect(out['url.query']).toBe('code=[REDACTED]&format=vtt');
  });
});

describe('the query carrier preserves the fragment instead of swallowing it (ALI-1190)', () => {
  it('keeps the fragment on http.target when the query needs redacting', () => {
    const out = redactSpanAttributes({ 'http.target': '/cb?code=AUTHCODE#tok' });
    expect(out['http.target']).toBe('/cb?code=[REDACTED]#tok');
  });

  it('keeps the fragment on the bare url.query carrier when the query needs redacting', () => {
    const out = redactSpanAttributes({ 'url.query': '?code=AUTHCODE#tok' });
    expect(out['url.query']).toBe('?code=[REDACTED]#tok');
  });

  it('keeps the fragment byte-identical when nothing in the query needs redacting (positive control)', () => {
    const input = { 'http.target': '/cb?page=2#section' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });

  it('keeps a fragment with no query at all byte-identical', () => {
    const input = { 'http.target': '/cb#section' };
    expect(redactSpanAttributes(input)).toEqual(input);
  });
});

describe('four more credential query-parameter names (ALI-1190)', () => {
  it.each([
    ['jwt', 'JWTVALUE'],
    ['assertion', 'ASSERTIONVALUE'],
    ['client_assertion', 'CLIENTASSERTIONVALUE'],
    ['signed_request', 'SIGNEDREQUESTVALUE'],
  ])('redacts ?%s= under BOTH url.query writer shapes', (name, value) => {
    expect(redactSpanAttributes({ 'url.query': `${name}=${value}` })['url.query']).toBe(
      `${name}=[REDACTED]`,
    );
    expect(redactSpanAttributes({ 'url.query': `?${name}=${value}` })['url.query']).toBe(
      `?${name}=[REDACTED]`,
    );
  });

  it.each([
    ['jwt_type', 'Bearer'],
    ['has_jwt', 'true'],
    ['assertion_method', 'x'],
    ['client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'],
    ['signed_request_id', '123'],
  ])('keeps ?%s= readable (anchoring control)', (name, value) => {
    const query = `${name}=${value}`;
    expect(redactSpanAttributes({ 'url.query': query })['url.query']).toBe(query);
    expect(redactSpanAttributes({ 'url.query': `?${query}` })['url.query']).toBe(`?${query}`);
  });
});

describe('percent-decoded parameter names are a known open boundary, not fixed here (ALI-1190)', () => {
  it('does NOT decode a percent-encoded parameter name before matching, so this leaks today', () => {
    const leaking = { 'url.query': '%63ode=AUTHCODE' };
    expect(redactSpanAttributes(leaking)).toEqual(leaking);
  });
});

describe('the credential-pattern arrays never carry the g flag (ALI-1190)', () => {
  it.each([
    ['REDACT_VALUE_KEY_PATTERNS', REDACT_VALUE_KEY_PATTERNS],
    ['REDACT_CONTENT_KEY_PATTERNS', REDACT_CONTENT_KEY_PATTERNS],
    ['REDACT_QUERY_PARAM_PATTERNS', REDACT_QUERY_PARAM_PATTERNS],
  ])('%s carries no /g pattern', (_name, patterns) => {
    for (const pattern of patterns) {
      expect(pattern.flags).not.toContain('g');
    }
  });

  it('positive control: a /g pattern IS detected by this assertion', () => {
    expect(/x/g.flags).toContain('g');
  });
});
