# Auth recipes — `createScoreSubmitHandler`

The built-in verifiers ([README](./README.md#turnkey-endpoint-createscoresubmithandler))
cover auth systems that issue **JWKS-verifiable bearer tokens** — Supabase,
Clerk, Auth0, Firebase, and any other provider via the generic `verifyJwt`.

This doc covers everything else: sessions that **cannot** be verified against a
public key set — encrypted session cookies (Auth.js), database-backed sessions
(Better Auth, roll-your-own), and provider backend SDKs. They all plug into the
same seam: the `verify` callback.

## The `verify` contract

```ts
verify: (req: Request) => Promise<{ playerId: string; metadata?: object } | null>;
```

- Return `{ playerId }` on success. The submitted `playerId` **always** comes
  from `verify` — a `playerId` in the request body is ignored.
- Return `null` to reject (→ `401 unauthorized`). Throwing also rejects with
  401; the error message is never surfaced to the client (it may carry token
  internals), so prefer returning `null` explicitly.
- Read identity from **headers/cookies only**. The request body is reserved for
  the score payload (`parseSubmission` consumes it).
- Optional `metadata` you return is trusted and **wins over** body metadata on
  key conflicts — use it for server-verified fields like a display name.
- The optional `rateLimit` gate runs **before** `verify`, so unauthenticated
  spam can't drive your auth/crypto work. Per-user limits belong inside
  `verify` (after you know who the user is).

## Auth.js / NextAuth — encrypted JWE sessions

Auth.js does not expose a JWKS: its session cookie is a **JWE** — encrypted
with a key derived from `AUTH_SECRET` — so only your server can read it. Two
ways to wire it:

### In a Next.js App Router route handler

Call your Auth.js instance's `auth()` inside `verify` — it reads the session
from the ambient request context:

```ts
// app/api/submit-score/route.ts
import { createScoreSubmitHandler } from 'scorezilla/server';
import { auth } from '@/auth'; // your Auth.js config

export const POST = createScoreSubmitHandler({
  secretKey: process.env.SCOREZILLA_SECRET_KEY!,
  boardId: process.env.SCOREZILLA_BOARD_ID!,
  verify: async () => {
    const session = await auth();
    return session?.user?.id ? { playerId: session.user.id } : null;
  },
});
```

> **Note:** `session.user.id` is not populated by default with the JWT session
> strategy — expose it in your Auth.js config's `session` callback
> (`session.user.id = token.sub`), or use the `getToken` recipe below, where
> `sub` is always present.

### Anywhere else (framework-agnostic)

`getToken` decrypts the session cookie (or `Authorization` header) directly
from the `Request` — no Next context needed, so it works in the handler's
`verify` on any runtime:

```ts
import { createScoreSubmitHandler } from 'scorezilla/server';
import { getToken } from 'next-auth/jwt'; // or '@auth/core/jwt' outside Next

export const handler = createScoreSubmitHandler({
  secretKey: process.env.SCOREZILLA_SECRET_KEY!,
  boardId: process.env.SCOREZILLA_BOARD_ID!,
  verify: async (req) => {
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET!,
      // The cookie name carries a __Secure- prefix on https. Auth.js infers
      // this from AUTH_URL; set it explicitly where AUTH_URL isn't available.
      secureCookie: true,
    });
    return token?.sub ? { playerId: token.sub } : null;
  },
});
```

NextAuth **v4** uses a different default cookie name — add
`cookieName: 'next-auth.session-token'` (or its `__Secure-` variant) to the
`getToken` call.

## Better Auth — database-backed sessions

Better Auth sessions are opaque tokens looked up server-side. Its server API
takes the request headers directly:

```ts
import { createScoreSubmitHandler } from 'scorezilla/server';
import { auth } from './auth'; // your Better Auth instance

export const handler = createScoreSubmitHandler({
  secretKey: process.env.SCOREZILLA_SECRET_KEY!,
  boardId: process.env.SCOREZILLA_BOARD_ID!,
  verify: async (req) => {
    const session = await auth.api.getSession({ headers: req.headers });
    return session ? { playerId: session.user.id } : null;
  },
});
```

## Any opaque session cookie

For roll-your-own sessions (or anything storing a session id in a cookie and
the session itself in a DB/KV/Redis), `verify` is a cookie parse + store
lookup:

```ts
const SESSION_COOKIE = 'sid';

verify: async (req) => {
  const cookies = req.headers.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookies);
  if (!match) return null;

  const session = await sessionStore.get(match[1]); // your DB / KV / Redis
  if (!session || session.expiresAt < now()) return null;

  return { playerId: session.userId };
},
```

Encrypted-cookie systems (e.g. iron-session) are the same shape — replace the
store lookup with the library's unseal/decrypt call and read the user id from
the decrypted payload.

## Provider backend SDKs

Already shipping a provider's admin SDK? Wrap it instead of re-verifying
tokens yourself. For example, Firebase Admin (alternative to the
`verifyFirebaseIdToken` JWKS preset):

```ts
import { getAuth } from 'firebase-admin/auth';

verify: async (req) => {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return { playerId: decoded.uid };
  } catch {
    return null; // bad signature / expired / wrong project
  }
},
```

The same pattern fits any backend SDK that authenticates a request or token
and hands back a stable user id.

## Returning trusted metadata

Anything your session already proves can ride along as trusted metadata — it
overrides whatever the client put in the body for the same keys:

```ts
verify: async (req) => {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  return {
    playerId: session.user.id,
    metadata: { displayName: session.user.name }, // server-verified, wins over body
  };
},
```

## OAuth identity and the secure path

`useAuthProvider` (from `scorezilla/identity`) is **client-authoritative**: it
proves the player's identity to the browser, not to your endpoint — the
`google:<sub>` / `github:<id>` ids arrive at your endpoint from the client,
with no credential attached for `verify` to check. (Yes, the GitHub flow's
exchange endpoint verifies identity — but only inside the sign-in popup; at
score-submit time the id is still client-asserted.) Combining `useAuthProvider`
with the secure path looks like one of these:

**Your app has real auth (recommended).** Trust comes from your auth platform;
the OAuth handle is just sign-in UX. Verify the platform session as usual —
the verified user id is the `playerId`:

```ts
// Identity for TRUST: the verified Supabase/Clerk/Auth0/Firebase session.
verify: verifySupabaseJwt({ supabaseUrl: process.env.SUPABASE_URL! }),
```

If you want the OAuth display identity alongside, send it in the request
body's `metadata` — it's treated as untrusted client data, which is exactly
what it is.

**OAuth-only, no backend auth.** You can still route submissions through
`createScoreSubmitHandler` to keep `sk_*` off the client and gain payload
validation + rate limiting — but identity stays client-asserted, and the
endpoint should say so:

```ts
// ⚠️ Client-asserted: any client can claim any id. Acceptable for casual
// boards; NOT for ranking-sensitive ones — add real auth for that.
verify: async (req) => {
  const playerId = req.headers.get('x-player-id'); // e.g. the google:<sub> id
  return playerId ? { playerId } : null;
},
```

There is no middle option: an id that arrives from the browser without a
verifiable credential cannot be promoted to trusted server-side, no matter
which OAuth provider produced it.

## Hardening checklist

- **Never** derive `playerId` from the request body or an unverified header —
  only from the verified session/token. (The handler enforces the body half of
  this for you.)
- Use a stable, non-PII user id as `playerId` (auth user id, not an email).
- Add a cheap per-IP `rateLimit` gate; do per-user limits inside `verify`.
- Keep secrets (`SCOREZILLA_SECRET_KEY`, `AUTH_SECRET`, session-store
  credentials) in env vars or a secret manager — never in client builds.
- Set `cors` only if the game is served from a different origin than the
  endpoint; omit it for same-origin.
