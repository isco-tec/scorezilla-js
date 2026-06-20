---
"scorezilla": patch
---

Add the newer server error codes to the `ScorezillaErrorCode` union so consumers get autocomplete + type-checking when branching on them: `player_banned`, `name_taken`, `board_archived`, `turnstile_required`, `turnstile_failed`, `origin_not_allowed`. (Runtime behavior is unchanged — the union's open tail already carried these strings at runtime.) The `submitScore` `@throws` JSDoc now lists `player_banned` and `name_taken` as possible outcomes.
