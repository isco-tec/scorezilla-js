---
'scorezilla': patch
---

Fix: score submission now works from plain-http origins (LAN IPs, non-localhost dev hostnames).

`crypto.randomUUID()` — used to mint the per-POST idempotency key — is only available in secure contexts (https / `http://localhost`). On a plain-http origin it's absent, so every submit threw before the request was sent; with fire-and-forget submits, scores saved locally but never reached the server. The SDK now falls back to a `crypto.getRandomValues()`-derived UUID v4 (available in every context), so writes succeed everywhere. The same cross-context generator now backs the HMAC nonce and the anonymous player-id mint (replacing a weaker `Math.random()` fallback).
