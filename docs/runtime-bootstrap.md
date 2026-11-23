# Streaming runtime application bootstrap

The application entrypoint initializes the streaming runtime before React
renders. Windows Tauri uses its trusted invoke bridge. Android detects the
native Capacitor platform and loads the installed plugin modules. A browser
build may connect to the existing local Node API and use its server-side
account manager; it never stores provider secrets in browser storage.

## Windows

Tauri exposes `window.__TAURI__.core.invoke` because
`withGlobalTauri` is enabled in `src-tauri/tauri.conf.json`. The bootstrap
passes that bridge to the existing Windows Credential Manager and native HTTP
adapters. No session material is copied into React state or browser storage.

## Android

Install the repository dependencies with `npm ci`. The Capacitor runtime and
secure-storage plugin are pinned in `package.json` and `package-lock.json`.
Run `npm run setup:platforms` to install the native Android and Tauri tooling.
Then run:

```sh
npm run build
npx cap sync android
```

The app detects `Capacitor.isNativePlatform()` and
`Capacitor.getPlatform() === "android"`. It then dynamically loads
`SecureStorage` from `@capnative/capacitor-secure-storage`; `CapacitorHttp`
is provided by the already bundled `@capacitor/core` runtime. Capacitor's native plugin registry
is populated by `npx cap sync android`. The optional Android modules are not
loaded in a normal browser build.

An explicit `window.__MIDO_STREAMING_ANDROID__` dependency injection bridge
is still supported for tests and controlled embedding. The native bootstrap never falls back to localStorage or IndexedDB. In a
normal browser, the bootstrap checks for the trusted local API and composes
the web runtime only when that API reports local mode. If the API is
unavailable, the app keeps the local library available without an account
runtime.

## Browser local API

The browser account manager calls only same-origin local API endpoints for
non-secret account status. Provider sessions and provider HTTP requests must
remain on the trusted local server. The current web routes deliberately report
AnimeGO and Anixart adapters as unsupported; they do not accept passwords,
cookies, tokens, or arbitrary upstream URLs.

This is local browser support for the desktop/local application, not a
public multi-user deployment. Public hosting requires authenticated user
isolation and a separate encrypted per-user secret store. See
[web-streaming-account-runtime.md](./web-streaming-account-runtime.md).

## Provider readiness

Runtime composition is not provider authentication. No AnimeGO or Anixart
account adapter is registered by default, and their account login and remote
list writes remain unsupported pending verified, permitted protocols. This
bootstrap does not enable cookie extraction, private API calls, or remote
writes.

## Validation

Unit tests cover Tauri detection, explicit Android dependency injection,
native Android plugin loading, browser local API detection, browser-only
fallback behavior, and platform precedence. Native Windows and Android builds still require platform SDK
validation.
