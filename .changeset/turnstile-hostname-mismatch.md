---
'scorezilla': patch
---

Add `turnstile_hostname_mismatch` to the `ScorezillaErrorCode` union — a 403 the API can return when a Turnstile token is solved on an origin not allowed for the game. It previously fell through the open union as an untyped string; now it's a first-class code (with JSDoc) and documented in the API reference alongside the other 403 codes.
