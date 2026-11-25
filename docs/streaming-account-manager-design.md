# Streaming Account Manager foundation

Date: 2026-11-23

Branch: `feature/streaming-account-manager-foundation`

Base: `feature/streaming-account-auth-audit`

## Goal

Provide a shared, platform-neutral boundary for streaming account sessions without enabling unverified provider authentication. The local library remains independent from provider accounts and credentials.

## Implemented in this branch

- `src/services/streaming-account-session.ts` defines the injected `StreamingSecureSecretStore` contract.
- `StreamingAccountSessionVault` stores opaque provider session payloads under provider-specific keys.
- The vault has no browser-storage fallback and requires the host application to inject a secure-store implementation.
- Non-secret UI metadata is represented separately by `StreamingAccountSessionInfo`.
- `tests/streaming-account-session.test.ts` covers provider isolation, read/write/clear behavior, empty-payload rejection, and safe disconnected metadata.

## Security boundaries

- Never put passwords, cookies, bearer tokens, refresh tokens, or CSRF values in React state, localStorage, IndexedDB, logs, analytics, or the synced anime library.
- Do not synchronize provider sessions between devices.
- The secure-store adapter must be backed by the operating system: Android Keystore-backed storage on Android and Windows Credential Manager / OS keyring on Windows.
- Do not ship a plaintext or browser-storage fallback when native secure storage is unavailable. Report the provider connection as unavailable on that platform instead.
- The vault treats session payloads as opaque. Provider-specific adapters must define their own validated, minimal session format and must not persist the user's password.
- A WebView login does not imply that cookies may be extracted or replayed by the app's HTTP client. Any such bridge requires a separately reviewed provider contract and platform-specific implementation.

## Provider implementation status

| Provider | Authentication implementation | Read/write sync |
| --- | --- | --- |
| YummyAnime | Existing adapter remains unchanged | Existing limited list import/status/favorite writes |
| Anixart | Not implemented; private API contract and permission unverified | Disabled |
| AnimeGO | Not implemented; supported account interface and session handoff unverified | Disabled |

No provider capability flags were enabled by this foundation.

## Next implementation stages

1. Select and add the Windows and Android shells and their supported secure-storage plugins.
2. Implement native secure-store adapters and platform integration tests.
3. Implement an account lifecycle service with explicit states (disconnected, connecting, connected, expired, unsupported, error), secret redaction, and disconnect cleanup.
4. For Anixart, only implement direct API authentication after the service owner confirms an approved third-party API/contract. Keep the official CSV/TXT and Shikimori JSON file paths as fallback/interop.
5. For AnimeGO, first test a user-operated embedded login that leaves the session inside the platform WebView. Do not extract cookies or perform authenticated writes until permission and a stable supported request contract are confirmed.
6. Add provider-specific read adapters, normalize into the existing import/reconciliation path, then build a diff preview and explicit write queue only for verified write capabilities.

## Validation

- Unit tests are authored for the platform-neutral vault contract.
- Native secure-storage behavior is not yet implemented or tested because the repository does not yet include a selected Windows shell or Android native runtime.
- No Anixart or AnimeGO account capability is enabled by this branch.


## AnimeGO episode progress

Episode progress uses the first-party player page and its episode-list response. The native Windows adapter reads the active visible translation ID and episode IDs from the returned HTML, then compares each episode's current watched flag with the requested contiguous progress value. The site endpoint `POST /anime/episode/watched` is a toggle, not an idempotent setter: the adapter only sends a toggle for a mismatched episode, validates the JSON result, and re-reads the episode list after all changes. If a request has an unknown transport outcome, the durable queue retries by running the same read-before-write reconciliation, so already-applied toggles are not blindly repeated. The implementation is native Windows-only; Android account session support remains deferred.
