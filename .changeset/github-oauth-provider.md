---
'scorezilla': minor
---

feat(identity): ship the GitHub provider for `useAuthProvider` (scorezilla#194)

The GitHub option is real (and final, per ADR 0009): a popup OAuth web flow
on the client plus a turnkey server-side token exchange.

- `useAuthProvider({ provider: 'github', clientId, exchangeUrl, storageKey })`
  — opens the GitHub sign-in popup, validates the callback by origin + state,
  resolves `github:<id>` (or `null` on decline). The provisional option shape
  is finalized: `clientId`, `exchangeUrl`, and `storageKey` are all required.
- `createGitHubOAuthHandler({ clientId, clientSecret, allowedOrigin })` (new
  in `scorezilla/server`) — the deployable callback endpoint: exchanges the
  code (secret stays server-side), resolves the user id, posts it back to the
  game's origin, closes the popup. The access token never reaches the browser.
- size-limit: server caps 7 → 8 KB (documented); new tree-shaking proof pins
  that adapter-only consumers pay for neither factory.
