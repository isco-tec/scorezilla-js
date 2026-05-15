---
'scorezilla': minor
---

**`scorezilla/server`: HMAC requests now bind to the target host (v=2).**

The canonical signing string includes the host of the request URL, so a signature minted against staging cannot be replayed against prod (or any other origin that happens to share key material). SigV4 has had this since day one; closing the gap before MCP locks the format.

Wire format change:

```
Authorization: Scorezilla-HMAC-SHA256 keyId=…, ts=…, nonce=…, signature=…, v=2
```

The `v=2` parameter is new. The canonical signing string now has six lines instead of five — `host` is inserted between `METHOD` and `pathAndQuery`, lowercased per RFC 9110 §4.2.4.

**Backward compatibility.** The API verifier still accepts v=1 (no `v=` field, no host binding) during the rollout window — your existing pre-next.3 SDK builds will keep working until v=1 is deprecated. The SDK itself, however, emits v=2 unconditionally from next.3 onwards. If you've forked or wrapped `buildHmacAuthHeader` / `buildSigningString`, you'll need to thread a `host` parameter through.

**For consumers of `Scorezilla` from `scorezilla/server`:** no API changes. The constructor derives `host` from `baseUrl` automatically. As an added safety net, an invalid `baseUrl` now throws at construction time rather than producing 401 mismatches at every request.

**For low-level consumers of `buildSigningString` / `buildHmacAuthHeader`:** a new `host` parameter is now required. The latter also accepts an optional `version: 1 | 2` for explicit backward-compat scenarios.
