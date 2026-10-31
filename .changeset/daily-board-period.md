---
'scorezilla': minor
---

Daily boards: a `period` option on the read methods, and `period` on responses.

A Scorezilla board created with `period: 'daily_utc'` starts empty every UTC day. The SDK now supports it:

- `getLeaderboard`, `getPlayerRank`, and `getWindowAround` accept an optional `period: 'YYYY-MM-DD'` (UTC day) on the public-key client, the `scorezilla/server` client, and `getLeaderboard` on `scorezilla/headless`. Omit it to read today. Only today and the 30 days before it are accepted; anything else — or any `period` on an all-time board — is a `400 invalid_input`. The SDK does not validate the format locally.
- `SubmitScoreResponse`, `LeaderboardResponse`, both `PlayerRankResponse` variants, and `WindowAroundResponse` gain an optional `period?: string`, present only on daily boards. On submit it is the UTC day the score was filed under, and `rank` / `totalEntries` count that day only. `createScoreSubmitHandler` and the headless `submit()` result pass it through when present.

Submitting is unchanged, and all-time boards behave exactly as before.

```ts
const today = await sz.getLeaderboard({ boardId, top: 10 });
const yesterday = await sz.getLeaderboard({ boardId, top: 10, period: '2026-10-30' });
```
