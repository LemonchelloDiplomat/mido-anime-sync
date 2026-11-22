# Cross-platform Streaming Account Core

## Scope

This stage adds platform-neutral contracts for the account manager, HTTP transport, request queue, and synchronization preview. It does not activate Anixart or AnimeGO authentication.

## HTTP transport

- `StreamingHttpClient` accepts custom headers, including provider-required `Cookie`, `User-Agent`, and `X-CSRF-TOKEN` values.
- Android uses an injected Capacitor native HTTP plugin adapter.
- Windows uses an injected trusted native-process bridge suitable for a Tauri command or Electron main-process IPC.
- There is deliberately no renderer/browser `fetch` fallback. Browser fetch cannot bypass CORS.
- The Windows bridge and Android plugin are structural interfaces only in this stage. No Capacitor/Tauri/Electron runtime dependency has been added because the repository has not yet selected and configured those shells.
- Only HTTPS provider URLs are accepted, except localhost development endpoints.

## Session storage

The existing `StreamingAccountSessionVault` remains the only session persistence boundary. The host must inject a real OS-backed store. No browser storage fallback is allowed. Provider secrets must not be synchronized between devices.

## Account lifecycle

`StreamingAccountManager` handles connect, restore, disconnect, and safe status metadata. Provider adapters own their authentication protocols. Session payloads are never returned to UI callers.

## Rate limiting

`StreamingRequestQueue` serializes tasks per provider and enforces 1500 ms by default, configurable only between 1000 and 2000 ms. It is intended for provider mutations and other operations that require polite pacing.

## Diff Preview

`StreamingDiffPreview` is a proposal model. Local library changes must be applied through the existing reconciliation path. Remote writes must be explicitly selected and confirmed by the user. Missing remote entries must never imply deletion of local records.

## Not yet implemented

- Native Tauri/Windows HTTP bridge.
- Capacitor Android HTTP plugin installation and runtime wiring.
- Android Keystore and Windows Credential Manager adapters.
- Anixart endpoint contract verification and provider permission.
- AnimeGO embedded-login cookie handoff and provider permission.
- Provider-specific list parsers and remote write methods.
- UI screens for account management and diff preview.
