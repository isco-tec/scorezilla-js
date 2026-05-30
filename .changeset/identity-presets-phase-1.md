---
'scorezilla': minor
---

feat(identity): preset helpers for `scorezilla/identity` (Phase 1)

New subpath export: `scorezilla/identity`. Three identity-strategy
presets ship as `stable`; one OAuth helper ships as a preview stub.

**Stable in this release:**

- `useAnonymousPlayer({ storageKey })` — generates a UUID, persists in
  localStorage, same browser keeps the same id across reloads. Returns
  `{ id, forget() }`. Privacy-safe by default (no PII).
- `usePromptedPlayer({ storageKey, prompt })` — `window.prompt()` on
  first run, persists to localStorage. Returns `{ id, forget() } | null`
  (null when SSR, no `prompt`, or user cancels).
- `useServerAuthoritative()` — no-op marker for snippets using the
  HMAC-signed secure path (`scorezilla/server`). The browser SDK does
  no identity work; the server picks the value.

**Preview stub in this release (throws on call):**

- `useAuthProvider({ provider: 'google' | 'github' })` — OAuth-backed
  identity. Full implementation (Google + GitHub for v1) ships in a
  follow-up `next` release before the 0.3.0 latest promote.

Per [ADR 0003](https://github.com/isco-tec/scorezilla/blob/main/docs/adr/0003-mcp-identity-axis.md). All helpers document where data is stored and
what `forget()` / `signOut()` does NOT do (server-side history is
retained — call admin delete-player for full erasure).

Closes upstream tracking issue isco-tec/scorezilla#125 (Phase 1).
