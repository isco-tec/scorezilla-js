---
'scorezilla': minor
---

Handle HTTP 402 `usage_cap_exceeded` + observe API deprecation headers.

**402 / `usage_cap_exceeded`**: when the server returns 402 (tenant hit
their monthly submission cap or is suspended), the SDK now surfaces a
typed `ScorezillaError` with the full cap context:

- `err.code === 'usage_cap_exceeded'`
- `err.reason === 'over_cap' | 'suspended'`
- `err.tier`, `err.cap`, `err.count`, `err.period`, `err.resetsAt`
- `err.isUsageCapExceeded()` predicate
- `err.isSuspended()` predicate (distinguishes the suspended sub-case)
- `err.isTransient() === false` — no auto-retry (the cap doesn't lift
  until `resetsAt`)

**Deprecation signals**: when an API response carries an RFC 8594
`Sunset` header or IETF `Deprecation` header, the SDK now logs a
once-per-process `console.warn` so developers see deprecation
notices during dev without prod-loop spam. The warning includes the
sunset date and any `Link: rel="deprecation"` documentation URL.

No breaking changes. New fields are additive; existing error handling
keeps working unchanged.
