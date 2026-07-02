---
'scorezilla': patch
---

Type the SDK-synthesized transport codes: `ScorezillaErrorCode` now includes
`'network_error'`, `'aborted'`, and `'timeout'` (status 0 — no HTTP response
was received). These were always produced at runtime by `ScorezillaError` and
documented in `API.md`; the union now matches that reality, so narrowing on
them gets autocomplete instead of falling into the open-union tail. Types-only;
no runtime change.
