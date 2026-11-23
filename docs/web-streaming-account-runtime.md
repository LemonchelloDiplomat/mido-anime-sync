# Web streaming account runtime

## Scope

The browser build can run the shared Account Manager UI through the existing
local Node API. This is the local web application started by `npm run dev`
or the Windows launcher, not a publicly hosted multi-user service.

The browser receives account status metadata only. Provider passwords,
cookies, access tokens, refresh tokens, and CSRF values must remain on the
local server and must never be returned by account endpoints or written to
localStorage, IndexedDB, the anime library, or export files.

## Current implementation boundary

- The browser discovers the local API through `GET /api/health`.
- AnimeGO and Anixart status endpoints report that no verified server-side
  account adapter is registered yet.
- Disconnect is idempotent while no provider adapter exists.
- No provider login, credential submission, cookie extraction, private API
  request, list import, or remote write is enabled by these routes.
- Native Windows continues to use Windows Credential Manager.
- Android continues to use Android Keystore.

## Why the local API owns web sessions

A browser-only secret vault would expose provider session material to renderer
JavaScript and browser storage. The local Node API is already the trusted
process used by the local app and can later own provider-specific authentication
and encrypted session persistence without sending secrets back to the UI.

## Public hosting is a separate deployment target

A public multi-user web deployment must not reuse the current single-user
`.local-data/tokens.enc.json` store. Before public hosting, add authenticated
user identities, per-user isolated encrypted secret storage, HTTPS, CSRF and
Origin validation, strict rate limits, secret rotation, audit-safe redaction,
and account deletion. Never share one server-side provider session across
unrelated users.

## Next implementation phases

1. Add a verified server-side adapter contract and encrypted provider-session
   persistence, isolated from MAL/AniList/Shikimori tokens.
2. Add a provider login flow only after its supported and permitted protocol
   has been confirmed.
3. Add account list read/import with preview and safe reconciliation.
4. Add remote writes only where provider capabilities and authorization allow.
5. Add authenticated per-user isolation before considering public hosting.
