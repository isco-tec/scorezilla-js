---
'scorezilla': minor
---

`getPlayerRank` no longer treats "no entry yet" as an error.

The rank endpoint now returns `200 { ranked: false }` for a player with no submission instead of a `404` — a 404 forced an un-suppressable red console line in every integrator's devtools for a perfectly normal "has this player scored?" check. `PlayerRankResponse` is now a union discriminated on `ranked`: narrow on it before reading `rank`/`score`. A `not_found` is still thrown only when the board itself doesn't exist.

Migration:

```ts
// Before
try {
  const { rank } = await sz.getPlayerRank({ boardId, playerId });
} catch (e) {
  if (e instanceof ScorezillaError && e.isNotFound()) { /* no entry */ }
}

// After
const r = await sz.getPlayerRank({ boardId, playerId });
if (r.ranked) { /* r.rank, r.score, … */ }
else { /* no entry yet */ }
```
