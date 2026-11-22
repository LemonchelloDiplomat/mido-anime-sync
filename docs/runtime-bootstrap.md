# Native streaming runtime application bootstrap

The application entrypoint initializes the streaming runtime before React
renders. Windows Tauri uses its trusted invoke bridge. Android detects the
native Capacitor platform and loads the installed plugin modules.

## Windows

Tauri exposes `window.__TAURI__.core.invoke` because
`withGlobalTauri` is enabled in `src-tauri/tauri.conf.json`. The bootstrap
passes that bridge to the existing Windows Credential Manager and native HTTP
adapters. No session material is copied into React state or browser storage.

## Android

Run `npm run setup:platforms` to install the Capacitor 8 dependencies and
`@capnative/capacitor-secure-storage`. Then run:

```sh
npm run build
npx cap sync android
```

The app detects `Capacitor.isNativePlatform()` and
`Capacitor.getPlatform() === "android"`, then dynamically loads
`SecureStorage` from `@capnative/capacitor-secure-storage` and
`CapacitorHttp` from `@capacitor/core`. Capacitor's native plugin registry
is populated by `npx cap sync android`. The optional Android modules are not
loaded in a normal browser build.

An explicit `window.__MIDO_STREAMING_ANDROID__` dependency injection bridge
is still supported for tests and controlled embedding. The bootstrap never
falls back to localStorage, IndexedDB, or browser fetch. If plugin loading
fails, the app logs the native initialization error and leaves the local
library available.

## Provider readiness

Runtime composition is not provider authentication. No AnimeGO or Anixart
account adapter is registered by default, and their account login and remote
list writes remain unsupported pending verified, permitted protocols. This
bootstrap does not enable cookie extraction, private API calls, or remote
writes.

## Validation

Unit tests cover Tauri detection, explicit Android dependency injection,
native Android plugin loading, browser no-fallback behavior, and platform
precedence. Native Windows and Android builds still require platform SDK
validation.
