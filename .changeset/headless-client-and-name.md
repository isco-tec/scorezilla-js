---
"scorezilla": minor
---

Add the headless, never-throws client and cross-platform submit fields.

- **`scorezilla/headless`** — a new subpath exposing `createHeadlessClient(config)` with `submit(...) → { ok, rank, totalEntries, isPersonalBest } | null` and `getLeaderboard(...) → RankedEntry[]` that **never throw**: failures collapse to `null` / `[]`. This is the identical headless surface a host wraps so embedded game code never changes between platforms. Plus `isCrossOrigin(homeOrigin)` to detect cross-site embedding and decide whether the token path is needed.
- **`submitScore` / headless `submit`** now accept an optional **`name`** (public display name) and **`turnstileToken`** (the cross-origin token path); both are forwarded on the wire.
- **`RankedEntry`** now carries an optional **`name`** — the display name returned by the leaderboard read.

The throwing `Scorezilla` class is unchanged; reach for it when you want typed `ScorezillaError`s to branch on.
