/**
 * Tests for `createGitHubOAuthHandler` (`scorezilla/server`) — the
 * server-side callback leg of the GitHub provider.
 *
 * GitHub redirects the sign-in popup to this endpoint with `?code=&state=`.
 * The handler exchanges the code (client secret stays server-side), fetches
 * the GitHub user id, and responds with a tiny HTML page that postMessages
 * `{ source, state, id }` to `window.opener` pinned to `allowedOrigin`,
 * then closes the popup.
 *
 * Security invariants pinned here:
 *   • the access token NEVER appears in the response body;
 *   • `state` is format-validated and never reflected when invalid (XSS);
 *   • postMessage targetOrigin is the configured allowedOrigin, not `*`;
 *   • GitHub API calls carry Accept: application/json + a User-Agent.
 */

import { describe, expect, it } from 'vitest';
import { createGitHubOAuthHandler } from '../../src/server';

const CLIENT_ID = 'Iv1_test1234567890ab';
const CLIENT_SECRET = 'ghs_testsecret_never_in_output';
const ALLOWED_ORIGIN = 'https://mygame.example';
const ACCESS_TOKEN = 'gho_testtoken_never_in_output';
const STATE = 'abc123_DEF456-ghi789';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** Fetch stub for the two GitHub legs; records every call. */
function fakeGitHub(
  opts: {
    exchangeBody?: unknown;
    exchangeStatus?: number;
    userBody?: unknown;
    userStatus?: number;
  } = {},
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(
        JSON.stringify(opts.exchangeBody ?? { access_token: ACCESS_TOKEN, token_type: 'bearer' }),
        { status: opts.exchangeStatus ?? 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith('https://api.github.com/user')) {
      return new Response(JSON.stringify(opts.userBody ?? { id: 583231, login: 'octocat' }), {
        status: opts.userStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeHandler(fetchImpl: typeof fetch) {
  return createGitHubOAuthHandler({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowedOrigin: ALLOWED_ORIGIN,
    fetch: fetchImpl,
  });
}

function callbackRequest(params: Record<string, string>): Request {
  const url = new URL('https://mygame.example/api/github-oauth');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { method: 'GET' });
}

describe('createGitHubOAuthHandler — happy path', () => {
  it('exchanges the code, fetches the user, and posts { source, state, id }', async () => {
    const { fetchImpl, calls } = fakeGitHub();
    const handler = makeHandler(fetchImpl);

    const res = await handler(callbackRequest({ code: 'deadbeef1234', state: STATE }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    // The callback page must never be cached — it embeds a one-shot state.
    expect(res.headers.get('cache-control')).toMatch(/no-store/);

    // Security headers on the inline-script page.
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const html = await res.text();
    expect(html).toContain('scorezilla:github-oauth');
    expect(html).toContain(STATE);
    expect(html).toContain('583231');
    // The postMessage target is structurally the EXACT configured origin —
    // a JSON-stringified literal, not '*' and not interpolation residue.
    expect(html).toContain(`, ${JSON.stringify(ALLOWED_ORIGIN)})`);
    expect(html).not.toContain(`'*'`);
    expect(html).not.toContain(`"*"`);

    // Exchange leg: POST with the code + credentials, asking for JSON.
    const exchange = calls.find((c) => c.url.includes('login/oauth/access_token'));
    expect(exchange).toBeDefined();
    expect(exchange!.init.method).toBe('POST');
    const exchangeHeaders = new Headers(exchange!.init.headers);
    expect(exchangeHeaders.get('accept')).toMatch(/application\/json/);
    const body = String(exchange!.init.body);
    expect(body).toContain(CLIENT_ID);
    expect(body).toContain(CLIENT_SECRET);
    expect(body).toContain('deadbeef1234');

    // User leg: bearer token + the GitHub-mandated User-Agent.
    const user = calls.find((c) => c.url.includes('api.github.com/user'));
    expect(user).toBeDefined();
    const userHeaders = new Headers(user!.init.headers);
    expect(userHeaders.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(userHeaders.get('user-agent')).toBeTruthy();
  });

  it('never leaks the access token or client secret into the response', async () => {
    const { fetchImpl } = fakeGitHub();
    const handler = makeHandler(fetchImpl);
    const res = await handler(callbackRequest({ code: 'deadbeef1234', state: STATE }));
    const html = await res.text();
    expect(html).not.toContain(ACCESS_TOKEN);
    expect(html).not.toContain(CLIENT_SECRET);
  });
});

describe('createGitHubOAuthHandler — decline + failure relay', () => {
  it("relays GitHub's access_denied so the client resolves null", async () => {
    const { fetchImpl, calls } = fakeGitHub();
    const handler = makeHandler(fetchImpl);
    const res = await handler(callbackRequest({ error: 'access_denied', state: STATE }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('access_denied');
    expect(html).toContain(STATE);
    // No exchange attempted for a denial.
    expect(calls).toHaveLength(0);
  });

  it('relays exchange failure as an error payload (no token issued)', async () => {
    const { fetchImpl } = fakeGitHub({ exchangeBody: { error: 'bad_verification_code' } });
    const handler = makeHandler(fetchImpl);
    const res = await handler(callbackRequest({ code: 'expiredcode12', state: STATE }));
    const html = await res.text();
    expect(html).toContain('exchange_failed');
    expect(html).toContain(STATE);
  });

  it('relays a non-200 /user response as an error payload', async () => {
    const { fetchImpl } = fakeGitHub({ userStatus: 401, userBody: { message: 'Bad credentials' } });
    const handler = makeHandler(fetchImpl);
    const res = await handler(callbackRequest({ code: 'deadbeef1234', state: STATE }));
    const html = await res.text();
    expect(html).toContain('exchange_failed');
  });
});

describe('createGitHubOAuthHandler — input validation (XSS hardening)', () => {
  it('rejects a state with HTML-significant characters and never reflects it', async () => {
    const { fetchImpl, calls } = fakeGitHub();
    const handler = makeHandler(fetchImpl);
    const hostile = '"><script>alert(1)</script>';
    const res = await handler(callbackRequest({ code: 'deadbeef1234', state: hostile }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('<script>alert');
    expect(text).not.toContain(hostile);
    expect(calls).toHaveLength(0); // no exchange on invalid input
  });

  it('rejects a malformed code without calling GitHub', async () => {
    const { fetchImpl, calls } = fakeGitHub();
    const handler = makeHandler(fetchImpl);
    const res = await handler(callbackRequest({ code: 'not valid !!', state: STATE }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects when code or state is missing', async () => {
    const { fetchImpl } = fakeGitHub();
    const handler = makeHandler(fetchImpl);
    expect((await handler(callbackRequest({ state: STATE }))).status).toBe(400);
    expect((await handler(callbackRequest({ code: 'deadbeef1234' }))).status).toBe(400);
  });

  it('rejects non-GET methods', async () => {
    const { fetchImpl } = fakeGitHub();
    const handler = makeHandler(fetchImpl);
    const res = await handler(
      new Request('https://mygame.example/api/github-oauth', { method: 'POST' }),
    );
    expect(res.status).toBe(405);
  });
});

describe('createGitHubOAuthHandler — config validation', () => {
  it('throws at build time on a malformed allowedOrigin', () => {
    expect(() =>
      createGitHubOAuthHandler({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        allowedOrigin: 'mygame.example', // missing scheme
      }),
    ).toThrow(/allowedOrigin/);
  });

  it('throws at build time on missing credentials', () => {
    expect(() =>
      createGitHubOAuthHandler({
        clientId: '',
        clientSecret: CLIENT_SECRET,
        allowedOrigin: ALLOWED_ORIGIN,
      }),
    ).toThrow(/clientId/);
    expect(() =>
      createGitHubOAuthHandler({
        clientId: CLIENT_ID,
        clientSecret: '',
        allowedOrigin: ALLOWED_ORIGIN,
      }),
    ).toThrow(/clientSecret/);
  });
});
