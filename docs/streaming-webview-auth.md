# Streaming account sign-in through native WebViews

## Windows: AnimeGO first implementation

The Windows desktop app opens AnimeGO's own `/login` page in a dedicated Tauri WebviewWindow. The user enters credentials directly on the first-party website. The app does not render a credential form and does not receive the password.

After the user returns to the main app and selects **I signed in, verify**, the native command:

1. Confirms that the auth window is still on `https://animego.me`.
2. Reads cookies for the AnimeGO origin from the WebView2 cookie store, including HttpOnly cookies.
3. Sends the cookies from Rust to AnimeGO's homepage and checks the first-party `data-user` identity payload.
4. Stores the cookie pairs in Windows Credential Manager using the existing chunked secret vault.
5. Closes the auth window and returns only the non-secret account label to the renderer.

Cookies are never returned to React, the local Node API, IndexedDB, or the anime library. The generic account vault stores only a non-secret marker under the normal provider key. The actual cookie session is stored under a separate Windows Credential Manager key, so writing the marker cannot overwrite the cookies. Native status checks validate the actual cookie session inside Rust.

## Current scope and limitations

- Implemented in this phase: Windows WebView2 sign-in, identity verification, secure session persistence, status restoration, and disconnecting the app's stored session.
- Not implemented in this phase: native AnimeGO list retrieval through the stored session, remote status writes, ratings, or watch-progress writes.
- Browser mode does not have access to another origin's cookies and therefore does not provide this native sign-in flow. Use `npm run tauri:dev` to test Windows WebView2.
- Android is intentionally deferred. Tauri's `cookies_for_url` API documents that Android returns an empty cookie list; Android needs a platform-specific WebView/CookieManager adapter rather than reusing the Windows implementation.
- Closing the app connection removes the app's protected session copy. It does not clear all WebView browsing data or sign the user out of other website sessions.

## Security boundaries

- Only the exact HTTPS origin `animego.me` is accepted for sign-in verification.
- The native command validates the current auth window URL before reading cookies.
- Session cookies remain in Rust and Windows Credential Manager.
- No CAPTCHA, Cloudflare, or other anti-bot challenge is bypassed.
- The HTML `data-user` identity is treated as a verification signal, not as an authentication credential.
- This is a first-party website sign-in flow, not official OAuth or a documented public AnimeGO API.

## Relevant platform API

Tauri's `WebviewWindow::cookies_for_url` returns cookies for an HTTP(S) URL, including HttpOnly and Secure cookies. Its documentation warns that cookie reads can deadlock on Windows when called synchronously, so the native commands that read cookies are asynchronous.

- https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html#method.cookies_for_url
- https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html#method.builder
