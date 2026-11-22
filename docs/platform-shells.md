# Windows and Android platform shells

## Confirmed architecture

- Windows desktop: Tauri 2 + Microsoft WebView2.
- Android: Capacitor 8 + Android WebView.
- Local library remains offline-first and remains the source of truth.
- Account session secrets are isolated from library data and are never synced between devices.

## Implemented in this stage

### Windows / Tauri

- Tauri 2 application configuration and Rust entry point.
- Windows Credential Manager-backed secure secret commands through the Rust `keyring` crate.
- Secret values are base64 chunked before being written to Credential Manager, so session payloads are not limited to one small credential blob. The manifest is switched only after all new chunks are written.
- Native HTTP command uses `reqwest`, binds the requested provider ID to its own HTTPS host allowlist (`animego.me` or `anixart.site` and their subdomains), restricts methods and headers, caps request/response sizes, and only follows same-host redirects.
- Response headers are allowlisted; `Set-Cookie` is never returned to the web UI.

### Android / Capacitor

- Capacitor app configuration with native `CapacitorHttp` enabled.
- Platform adapter contracts for native HTTP and secure storage.
- Android secure storage is wired to the injected `@capnative/capacitor-secure-storage` plugin interface, which uses Android Keystore-backed AES-GCM storage and has no web fallback.
- Native HTTP is wired to the Capacitor native HTTP plugin interface, with the same provider-to-host checks enforced in the TypeScript adapter.

## First-time setup

Run from the repository root:

```powershell
npm run setup:platforms
```

The setup script installs:
- `@capacitor/core@^8`
- `@capacitor/android@^8`
- `@capnative/capacitor-secure-storage@^8`
- `@capacitor/cli@^8`
- `@tauri-apps/cli@^2`

It then creates the Android project with `npx cap add android`. The command updates `package.json` and `package-lock.json` locally.

Windows prerequisites:
- Rust stable MSVC toolchain.
- Microsoft C++ Build Tools with Desktop development with C++.
- Microsoft Edge WebView2 Runtime.

Android prerequisites:
- Android Studio.
- Android SDK / platform tools.
- JDK supported by the installed Android Gradle Plugin.

## Commands after setup

```powershell
npm run tauri:dev
npm run tauri:build
npm run cap:sync
npm run cap:open:android
```

## Data migration warning

Tauri WebView2 and Android WebView have separate application storage origins/profiles. The current browser IndexedDB library will not automatically appear inside the packaged Tauri or Capacitor app. Before asking users to switch to a native build, implement and test a one-time, non-destructive library migration from the browser build, preserving IDs, sync baselines, operation history, and schema versions.

## Important integration gap

The existing application still has a Node.js local API server (`server/index.mjs`) used by several existing integrations. Tauri's development command starts it through `npm run dev`, but a production Tauri bundle does not yet package or supervise that Node process. Android also cannot run the Node server as-is. Do not treat the native shells as feature-complete until the local API responsibilities have been moved into native commands or a properly packaged sidecar and the existing integrations have regression coverage.

The native transport and secure-store adapters are implemented as platform boundaries, but their end-to-end native runtime wiring and builds must be verified on Windows and Android devices before enabling account providers.
