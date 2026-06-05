---
'scorezilla': minor
---

feat(server): built-in `verifyJwt` + `verifySupabaseJwt` for `createScoreSubmitHandler`

Turn the common "verify a JWT, derive the player id" step into a one-liner.
Both return a `verify` function you drop straight into `createScoreSubmitHandler`.

```ts
import { createScoreSubmitHandler, verifySupabaseJwt } from 'scorezilla/server';

export const POST = createScoreSubmitHandler({
  secretKey: process.env.SCOREZILLA_SECRET_KEY!,
  boardId: process.env.SCOREZILLA_BOARD_ID!,
  verify: verifySupabaseJwt({ supabaseUrl: process.env.SUPABASE_URL! }),
});
```

- `verifyJwt({ jwksUrl, issuer, audience, claim? })` — generic JWKS verifier
  covering Clerk, Auth0, Firebase, WorkOS, and most providers (they differ only
  by config). `verifySupabaseJwt({ supabaseUrl })` is the Supabase preset.
- **`jose` is an optional peer dependency**, loaded lazily via dynamic
  `import()` — consumers who use the public-key client, the factory with their
  own `verify`, or a provider backend SDK never install or load it.
