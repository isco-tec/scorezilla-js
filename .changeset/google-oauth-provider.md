---
'scorezilla': minor
---

feat(identity): ship the Google provider for `useAuthProvider`

`useAuthProvider({ provider: 'google', clientId, storageKey })` is now
implemented and **stable**. It wraps Google Identity Services ("One Tap"),
derives a stable, opaque player id from the account's `sub` claim
(`google:<sub>`), and persists it in `localStorage` so returning visitors are
recognized without signing in again.

```ts
import { Scorezilla } from 'scorezilla';
import { useAuthProvider } from 'scorezilla/identity';

const player = await useAuthProvider({
  provider: 'google',
  clientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
  storageKey: 'mygame:player',
});

if (player) {
  const sz = new Scorezilla({ publicKey: 'pk_…' });
  await sz.submitScore({ boardId, playerId: player.id, score: 42 });
  // player.signOut() clears the persisted id and disables Google auto-select.
}
```

- **Resolves `null` when the player declines** or One Tap can't be shown — a
  dismissed sign-in is not an error. It **rejects** only on genuine failures
  (invalid args, script load failure, malformed credential).
- **`handle.source`** is `'signed-in'` for a fresh sign-in or `'restored'` when
  the id was rehydrated from `localStorage` (a restored id is not a re-verified
  live session).
- **Bring your own client ID.** The SDK never bundles Scorezilla-owned OAuth
  credentials, so revocation and consent stay under your control.
- **Privacy.** Only the derived `sub`-based id is stored and transmitted on
  score submission — never the Google credential, email, or profile.
- **Bundle.** The Google provider tree-shakes out for consumers who don't call
  `useAuthProvider`; the Google Identity Services library is loaded at runtime
  from `accounts.google.com`, never bundled.
- `useAuthProvider` is now async (replacing the `0.3.0-next.0` preview stub that
  threw synchronously). Despite the `use*` name it is **not** a React hook.
  Identity errors are plain `Error`/`TypeError` (not `ScorezillaError`), keeping
  the `scorezilla/identity` subpath dependency-free. The host page's CSP must
  allow `https://accounts.google.com`.
- The **GitHub** provider is not available yet — it ships in a follow-up and
  will require a server-side token exchange (your backend or a Scorezilla
  Workers proxy). Calling `useAuthProvider({ provider: 'github' })` rejects
  with guidance until then.
