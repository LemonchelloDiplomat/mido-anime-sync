# Native streaming runtime application bootstrap

The web application entrypoint calls `createStreamingRuntimeFromHost()` before
React renders. This creates the Windows runtime automatically when the trusted
Tauri v2 invoke bridge is present.

## Windows

Tauri exposes `window.__TAURI__.core.invoke` because
`withGlobalTauri` is enabled in `src-tauri/tauri.conf.json`. The bootstrap
passes that bridge to the existing Windows Credential Manager and native HTTP
adapters. No session material is copied into React state or browser storage.

## Android

The Android runtime is deliberately opt-in. The Capacitor native entrypoint
must register the secure-storage and native HTTP plugins, then inject their
plugin objects as `window.__MIDO_STREAMING_ANDROID__` before the app entrypoint
runs. The object must have this shape:

- `secureStorage.get({ key })`, `set({ key, value })`, and `remove({ key })`
- `http.request({ url, method, headers, data, ... })`

Until this native bridge is installed, the bootstrap returns `null`. It does
not fall back to localStorage, IndexedDB, or browser fetch.

## Provider readiness

Runtime composition is not provider authentication. No AnimeGO or Anixart
account adapter is registered by default, and the current capability matrix
continues to mark their account login and list writes as unsupported. This
bootstrap does not enable cookie extraction, private API calls, or remote
writes.

## Validation

Unit tests cover Tauri detection, explicit Android dependency injection,
browser no-fallback behavior, and deterministic platform precedence. The
existing CI typecheck and Vite build validate the application entrypoint.
Native Windows and Android builds still require platform SDK validation.
