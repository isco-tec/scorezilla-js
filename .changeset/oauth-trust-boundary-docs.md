---
'scorezilla': patch
---

docs: make the `useAuthProvider` trust boundary explicit (scorezilla#213)

Client OAuth identity is sign-in convenience, not anti-forgery — the derived
id is computed client-side and submitted with the public key. New
trust-boundary notes on the `useAuthProvider` JSDoc and `AuthPlayerHandle`, a
"Player identity" section in the README, and a RECIPES.md recipe ("OAuth
identity and the secure path") routing ranking-sensitive boards to
`createScoreSubmitHandler` with a server-verified identity.
