/**
 * Tests for `createScoreSubmitHandler` (#211) — the turnkey secure-submit
 * factory in `scorezilla/server`.
 *
 * Every test injects `fetch` so there's no network I/O; the captured request
 * lets us assert the most important security property: the submitted
 * `playerId` comes from `verify`, never from the request body.
 */
import { describe, expect, it, vi } from 'vitest';
import { createScoreSubmitHandler } from '../../src/server';
import type { FetchImpl } from '../../src/transport';

const VALID_KEY_ID = '9493330f-a9e6-4bd6-914f-100f1e51ac36';
const SECRET = `sk_live_${VALID_KEY_ID}_TestSecretValueAaBbCcDdEeFf`;
const BASE = 'https://api.example.com';

function apiSuccess(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      boardId: 'b',
      keyId: 'k',
      rank: 3,
      totalEntries: 50,
      isPersonalBest: true,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function apiError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function postReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://game.example/api/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

interface HarnessOverrides {
  verify?: (req: Request) => unknown;
  rateLimit?: (req: Request) => unknown;
  cors?: unknown;
  maxRetries?: number;
  fetchResponse?: () => Response;
}

function makeHandler(overrides: HarnessOverrides = {}) {
  const fetchImpl = vi.fn(async () =>
    (overrides.fetchResponse ?? apiSuccess)(),
  ) as unknown as FetchImpl;
  const handler = createScoreSubmitHandler({
    secretKey: SECRET,
    boardId: 'board-1',
    baseUrl: BASE,
    fetch: fetchImpl,
    verify: (overrides.verify ?? (async () => ({ playerId: 'verified-user' }))) as never,
    ...(overrides.rateLimit ? { rateLimit: overrides.rateLimit as never } : {}),
    ...(overrides.cors ? { cors: overrides.cors as never } : {}),
    ...(overrides.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
  });
  return { handler, fetchImpl };
}

function signedBody(fetchImpl: FetchImpl): Record<string, unknown> {
  const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return JSON.parse(String(calls[0][1].body));
}

describe('createScoreSubmitHandler', () => {
  it('signs + submits with the verified playerId and returns the result', async () => {
    const { handler, fetchImpl } = makeHandler();
    const res = await handler(postReq({ score: 42 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      rank: 3,
      totalEntries: 50,
      isPersonalBest: true,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/secure/scores`);
    const body = signedBody(fetchImpl);
    expect(body).toMatchObject({ boardId: 'board-1', playerId: 'verified-user', score: 42 });
  });

  it('derives playerId from verify, IGNORING any playerId in the request body', async () => {
    const { handler, fetchImpl } = makeHandler();
    const res = await handler(postReq({ score: 10, playerId: 'attacker-uuid' }));

    expect(res.status).toBe(200);
    expect(signedBody(fetchImpl).playerId).toBe('verified-user');
  });

  it('returns 401 and does not submit when verify returns null', async () => {
    const { handler, fetchImpl } = makeHandler({ verify: async () => null });
    const res = await handler(postReq({ score: 1 }));
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 401 when verify throws (no leak, no submit)', async () => {
    const { handler, fetchImpl } = makeHandler({
      verify: async () => {
        throw new Error('boom');
      },
    });
    const res = await handler(postReq({ score: 1 }));
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 405 for non-POST methods', async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request('https://game.example/api/score', { method: 'GET' }));
    expect(res.status).toBe(405);
  });

  it('returns 400 for a missing or non-numeric score', async () => {
    const { handler, fetchImpl } = makeHandler();
    expect((await handler(postReq({ name: 'x' }))).status).toBe(400);
    expect((await handler(postReq({ score: 'NaN' }))).status).toBe(400);
    expect((await handler(postReq({ score: Number.POSITIVE_INFINITY }))).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rate-limits BEFORE verify when the gate denies', async () => {
    const verify = vi.fn(async () => ({ playerId: 'u' }));
    const { handler, fetchImpl } = makeHandler({
      verify,
      rateLimit: async () => ({ ok: false, retryAfterSeconds: 30 }),
    });
    const res = await handler(postReq({ score: 1 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(verify).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('merges metadata with verify winning on conflict', async () => {
    const { handler, fetchImpl } = makeHandler({
      verify: async () => ({ playerId: 'u', metadata: { tier: 'pro' } }),
    });
    await handler(postReq({ score: 1, metadata: { name: 'Ori', tier: 'free' } }));
    expect(signedBody(fetchImpl).metadata).toEqual({ name: 'Ori', tier: 'pro' });
  });

  it('handles a CORS preflight (OPTIONS) with the reflected origin', async () => {
    const { handler } = makeHandler({ cors: { origin: 'https://game.example' } });
    const res = await handler(
      new Request('https://game.example/api/score', {
        method: 'OPTIONS',
        headers: { Origin: 'https://game.example' },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://game.example');
  });

  it('omits Allow-Origin for a disallowed origin', async () => {
    const { handler } = makeHandler({ cors: { origin: 'https://game.example' } });
    const res = await handler(postReq({ score: 1 }, { Origin: 'https://evil.example' }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('maps an upstream client error to its status', async () => {
    const { handler } = makeHandler({
      maxRetries: 0,
      fetchResponse: () => apiError(400, 'out_of_bounds', { message: 'too high' }),
    });
    const res = await handler(postReq({ score: 999999 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('out_of_bounds');
  });

  it('maps an upstream rate-limit to 429 with Retry-After', async () => {
    const { handler } = makeHandler({
      maxRetries: 0,
      fetchResponse: () => apiError(429, 'rate_limited', { retryAfter: 12 }),
    });
    const res = await handler(postReq({ score: 1 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
  });

  it('maps an upstream 5xx to 502', async () => {
    const { handler } = makeHandler({
      maxRetries: 0,
      fetchResponse: () => apiError(500, 'internal_error'),
    });
    const res = await handler(postReq({ score: 1 }));
    expect(res.status).toBe(502);
  });
});
