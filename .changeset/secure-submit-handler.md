---
'scorezilla': minor
---

feat(server): `createScoreSubmitHandler()` — turnkey secure score submissions

A framework-agnostic factory in `scorezilla/server` that collapses the secure
(HMAC-signed) submission path from ~150 lines of boilerplate into a few. It
returns a standard `(Request) => Promise<Response>` handler — drop it into a
Cloudflare Worker, a Next.js route handler, Hono, Deno, or Bun.

```ts
import { createScoreSubmitHandler } from 'scorezilla/server';

export const POST = createScoreSubmitHandler({
  secretKey: process.env.SCOREZILLA_SECRET_KEY!,
  boardId: process.env.SCOREZILLA_BOARD_ID!,
  verify: async (req) => {
    // your auth — any provider; return the trusted playerId
    const user = await myAuth(req);
    return user ? { playerId: user.id } : null;
  },
});
```

- The submitted `playerId` always comes from `verify` (the verified request),
  never the request body — so ranking-sensitive boards aren't subject to the
  client-authoritative submission of the public-key path.
- Owns body parsing/validation, HMAC signing, and `ScorezillaError` → HTTP
  status mapping. Optional `cors` (OPTIONS preflight + reflected origin) and a
  pre-verify `rateLimit` gate.
- Works with **any** auth via the `verify` callback (Supabase / Clerk / Auth0 /
  Firebase JWTs, Lucia / opaque sessions, or a provider backend SDK). First-class
  one-line verifiers (`verifySupabaseJwt`, `verifyJwt`) follow.
