# Streaming Account Authentication Audit

Date: 2026-11-23

Branch: `feature/streaming-account-auth-audit`

Audit base: PR #42 head `ce9410fff99e1723b1456ddedc3079f973cef80d` (which includes the stacked work from PRs #40 and #41). This branch is intentionally based on that integration branch, not on `main`, so the audit can be reviewed together with its dependencies.

## Executive summary

The repository already has streaming catalog adapters and partial account-data import paths, but it does **not** currently implement direct account authentication for Anixart or AnimeGO.

| Provider | Existing account-related implementation | Direct sign-in | Account list import | Remote list writes |
| --- | --- | --- | --- | --- |
| Anixart | Official user-export CSV/TXT parser | No | Via user-selected export file | No |
| AnimeGO | Profile-list payload normalizer and browser-extension capture path | No app-owned sign-in | Read-only capture through extension | No |
| YummyAnime | Local-server account API adapter | Yes, existing login flow | Yes | Limited mapped status/favorite writes |

Do not expose disabled controls as if a connection is available. Catalog access, extension watch events, and account synchronization are separate capabilities.

## Code inventory

### Shared contracts and capability declarations

- `src/services/streaming-provider.ts`
  - Defines provider IDs, catalog/account interfaces, and the central capability matrix.
  - AnimeGO and Anixart correctly declare `accountConnection`, `listImport`, and `listWrite` as false.
  - YummyAnime is the only streaming provider currently declaring account connection and list writes.
- `src/services/streaming-tracker-registry.ts`
  - Exposes account adapters for all three providers.
  - YummyAnime delegates to its local API.
  - AnimeGO and Anixart are explicit unsupported stubs. Their `connect`, `importList`, and disconnect operations do not authenticate.
- `src/services/streaming-account-import.ts`
  - Shared normalization/merge path for imported account records. Must remain the single path into the local library after provider-specific parsing.

### AnimeGO

- `src/services/animego.ts` is a public catalog client. It calls local `/api/animego/*` routes for search, title details, and episode voice metadata. It does not authenticate a user.
- `server/animego-routes.mjs` scrapes public pages and public episode metadata. Its capability response does not claim account API support.
- `src/services/animego-account-import.ts` normalizes one profile list at a time (list types 1–6). It validates the profile URL, deduplicates numeric AnimeGO IDs, and deliberately marks progress and favorite state as unknown. This is a parser/normalizer, not an authentication client.
- The existing account-list path in PR #40 uses the browser extension and the user's already signed-in browser session. It is read-only and does not provide app-owned Windows/Android login, cookie extraction, or remote writes.
- No app-owned AnimeGO account session manager, secure credential store, login flow, or authenticated server route was found in the audited service contracts.

### Anixart

- `src/services/anixart.ts` and `server/anixart-routes.mjs` provide public catalog/player metadata only.
- `src/services/anixart-export-import.ts` parses user-provided official CSV/TXT bookmark exports. It preserves available status, score, favorite and external ID data, while leaving fields absent from the export unknown.
- The account adapter in `src/services/streaming-tracker-registry.ts` is an unsupported stub. There is no Anixart password/token login, account session, account-list fetch, or remote status-write implementation.
- The repository's PR #40/#42 documentation records that no supported third-party account API contract has been established and that the available unofficial API material warns against third-party use. Do not add reverse-engineered private endpoints or ask users for their Anixart password unless the service owner provides a supported integration route or written permission.

## External research: official information and integration constraints

Research performed on 2026-11-23. This section distinguishes statements made by the services from observations in unofficial third-party material.

### Anixart

Official sources:

- [Anixart FAQ](https://anixart-app.com/faq) documents account features, cross-device viewing marks, and bookmark export/import.
- [Anixart Terms](https://anixart-app.com/terms) describe account registration via email/password and supported identity providers, and place responsibility for account access credentials on the user.

Confirmed from the official FAQ:

- Users can export bookmarks as CSV or TXT.
- Export can include the lists «Избранное», «Смотрю», «В планах», «Просмотрено», «Отложено», and «Брошено», with available title variants, status, and score fields.
- The documented import flow is for Shikimori JSON. The FAQ explicitly says an Anixart export cannot be imported into another Anixart account.
- Episode watch marks are stored in the account and visible on the user's devices after sign-in. Marks are associated with a selected source and voice/subtitle track; older marks may eventually be removed.
- The last playback position is described as device-local, not account-synchronized.

Unofficial material:

- The archived `Nekonyx/anixart-api` client explicitly describes itself as unofficial, says Anixart has no official API, warns that third-party use is not permitted, and notes that the request format can change. Other unofficial API wrappers and reference sites exist, but their existence does not establish permission, stability, or a supported contract.

Implementation decision:

- **Do not implement direct Anixart login or private API calls in this project at this stage.**
- Keep and improve the official CSV/TXT import parser. Add a first-class Anixart CSV/TXT export from the local library so users can move data in the direction Anixart officially supports only partially.
- If account-level sync is still desired, ask Anixart support for written confirmation of an approved third-party integration/API and permitted read/write operations before implementation.
- Do not infer that watch-mark endpoints are safe to call simply because unofficial documentation lists them.

References:
- https://anixart-app.com/faq
- https://anixart-app.com/terms
- https://github.com/Nekonyx/anixart-api

### AnimeGO

Official sources:

- [AnimeGO Terms](https://animego.biz/agreement.html)
- [AnimeGO Privacy Policy](https://animego.biz/privacy.html)
- [AnimeGO Contacts](https://animego.biz/contacts.html)
- [AnimeGO viewing-history announcement](https://animego.biz/4435-istorija-prosmotra.html)

Confirmed from the currently published public pages:

- AnimeGO describes itself as having personal lists and account-related functionality.
- Its privacy page says the site uses cookies, session data, account settings, viewing history, and episode marks to support account operation and playback progress.
- A site announcement describes a viewing-history page containing the last 50 player launches, including season, episode, and selected voice track.
- The public terms/privacy pages found during this audit do not provide a documented public API contract, OAuth/device flow, or a documented account-list export format.
- The terms page fetched by search describes account features and cautions against abuse of service capabilities. The full page could not be independently opened by the research tool (HTTP access failure), so no more specific contractual conclusion is made here.

Implementation decision:

- **Do not build a password-to-private-endpoint login or cookie extraction flow based on assumptions.**
- Keep the existing parser/normalizer and read-only extension capture as optional paths while investigating a first-party supported integration.
- A future embedded WebView can be evaluated as a user-operated way to open the provider's own login page, but the WebView session must remain inside its platform-owned cookie store. Do not export cookies, copy session identifiers into JavaScript/local storage, or silently replay authenticated requests.
- Before enabling automated reading or writing, obtain confirmation from AnimeGO support that third-party account access is permitted and determine whether the site offers a stable supported export/API.
- Contact listed by AnimeGO: `kinostroys@yandex.ru`.

References:
- https://animego.biz/agreement.html
- https://animego.biz/privacy.html
- https://animego.biz/contacts.html
- https://animego.biz/4435-istorija-prosmotra.html

## Security and architecture findings

1. The current application is a React/Vite web application with a local Node.js server. The package currently has no Capacitor, Electron, Tauri, or native secure-storage dependency. A future Windows/Android packaging plan must therefore be treated as a separate platform decision.
2. Do not store service passwords in localStorage, IndexedDB, app state, logs, or the local library database.
3. Do not assume a WebView's cookie jar can be exported safely or portably. Android WebView, Android Custom Tabs, Windows WebView2, and external browsers have different session boundaries and cookie APIs.
4. Prefer a service-supported OAuth/device authorization flow where available. If a provider supports a first-party login page but no delegated authorization contract, first verify its terms and supported session handoff before implementing any cookie-based bridge.
5. Keep any future provider session in platform secure storage, not in shared synced library data. Never sync provider cookies/tokens between devices.
6. Keep provider-specific network access behind a narrow adapter. The React UI should receive connection status and normalized records, never raw passwords, cookies, CSRF values, or bearer tokens.
7. Keep imports previewable and non-destructive. No missing remote record should delete a local entry; fuzzy title matches require user confirmation; writes must be explicit and separately confirmed.

## Work remaining before implementation

### Anixart

- Ask the service owner whether a supported third-party API, OAuth flow, or documented export/import contract exists.
- Until permission/support is established, retain official CSV/TXT import and improve its UX if needed.
- Add local-library-to-Anixart-compatible CSV/TXT export, clearly labeling it as a file export rather than an account write.
- Do not implement private mobile API login or token extraction based solely on unofficial clients.

### AnimeGO

- Ask the service owner whether third-party account access, list reading, and progress writes are permitted, and whether a stable API or export exists.
- Validate profile/list page structure and list-type semantics against current live pages, without collecting or persisting user credentials.
- If only browser-session access is technically possible, evaluate a user-controlled, read-only handoff separately for Android and Windows. Do not assume cookie extraction or automated POST writes are acceptable.
- Do not enable remote writes until a supported, stable request contract and permission are verified.

### Cross-platform

- Decide the Windows shell (Tauri or Electron) and confirm the Android Capacitor plan.
- Define a platform-neutral secure-storage interface with native implementations.
- Define account lifecycle states: `disconnected`, `connecting`, `connected`, `expired`, `unsupported`, and `error`.
- Add tests for credential redaction, session isolation, disconnect cleanup, expired sessions, and provider capability gating.

## Recommended next step

Implement the low-risk, immediately useful work first: harden Anixart CSV/TXT import tests and add local-library export in compatible formats. In parallel, send concise permission/API questions to AnimeGO and Anixart support. Do not block local/offline library work on undocumented account APIs.

## Acceptance criteria for this audit stage

- [x] Existing account-related files and provider capability declarations identified.
- [x] Catalog functionality separated from account authentication and list synchronization.
- [x] Current Anixart and AnimeGO implementation limits documented.
- [x] Credential/session security constraints documented.
- [x] Current official FAQ/terms/privacy information reviewed and linked.
- [ ] Provider-owner confirmation of permitted third-party account access obtained.
- [ ] Windows and Android packaging and secure-storage approach selected.
