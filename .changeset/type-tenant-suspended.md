---
'scorezilla': patch
---

Add `tenant_suspended` to the `ScorezillaErrorCode` union — a `402` the read paths (`getLeaderboard` / `getPlayerRank` / `getWindowAround`) return when the board's tenant is suspended. It previously fell through the open union as an untyped string; now it's typed (with JSDoc) and documented in the API reference. (On submit, the same condition still surfaces as `usage_cap_exceeded` with `reason: 'suspended'`.)
