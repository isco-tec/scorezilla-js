---
'scorezilla': minor
---

**v0.2.0 — HMAC server adapter (`scorezilla/server`).** Closes #17.

The new `scorezilla/server` subpath ships an HMAC-SHA256 signing client for
game backends that need cheat-resistant submissions. The browser-side
public-key client (`scorezilla`) is unchanged.

```ts
import { Scorezilla } from 'scorezilla/server';

const sz = new Scorezilla({
  secretKey: {
    id: process.env.SCOREZILLA_KEY_ID,
    secret: process.env.SCOREZILLA_KEY_SECRET, // never ship to a browser
  },
});

await sz.submitScore({ boardId, playerId, score, metadata });
await sz.getLeaderboard({ boardId, top });
await sz.getPlayerRank({ boardId, playerId });
await sz.getWindowAround({ boardId, playerId, before, after });
```

Behavior:

- Each request is signed with HMAC-SHA256 over a canonical
  `{ts}\n{nonce}\n{METHOD}\n{path?query}\n{sha256_hex(body)}` string and
  delivered via `Authorization: Scorezilla-HMAC-SHA256 keyId=…, ts=…,
  nonce=…, signature=…`. Matches the API's verifier byte-for-byte.
- `submitScore` posts to `/v1/secure/scores` (the boardId moves into the
  body — the public-key endpoint at `/v1/boards/:id/scores` is unchanged).
- Read methods (`getLeaderboard` / `getPlayerRank` / `getWindowAround`)
  hit the same paths as the public-key client.
- Every retry attempt regenerates `(ts, nonce)` so server-side replay
  protection (10-minute nonce window) doesn't trip.
- Importing `scorezilla/server` from a browser bundle throws at module
  evaluation — the `sk_live_*` secret never reaches client-side code.

Same `ScorezillaError` surface (`isRateLimited()`, `isAuth()`,
`isTransient()`, `code`, `requestId`, etc.) — typed catch patterns
written for v0.1 work unchanged.

Bundle: ~3.84 KB ESM gzipped, ~4.04 KB CJS gzipped — well under the
6 KB per-entry cap.
