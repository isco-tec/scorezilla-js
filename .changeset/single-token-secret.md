---
'scorezilla': minor
---

**`scorezilla/server` adopts a single-token secret-key format.** Breaking
change vs. v0.1.0-next.1; we're still in pre-release so this is permitted.

Before (v0.1.0-next.1):

```ts
new Scorezilla({
  secretKey: { id: 'sk-id-uuid', secret: 'sk_live_xxxxx' },
});
```

After (v0.1.0-next.2):

```ts
new Scorezilla({
  secretKey: 'sk_live_<keyId>_xxxxx', // one self-contained token
});
```

The keyId is embedded in the secret string itself; the SDK parses it
out via `/^sk_live_([0-9a-f]{8}-...)_/` before signing. The HMAC key
remains the WHOLE plaintext. Wire format on the Authorization header
is unchanged. API verification is unchanged.

Rationale: matches Stripe's design and the public-key client's
single-string shape. One value to copy from the dashboard, one to
manage in env config, one to pass into the constructor. Previously
users had to manage two distinct values (`id` AND `secret`) which
created confusion — they're functionally one credential.

**To upgrade**: issue (or rotate) a fresh secret key in the dashboard.
Old-format keys (no embedded keyId) are rejected by the SDK with a
clear error message pointing at the migration path.
