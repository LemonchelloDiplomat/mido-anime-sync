# Streaming account list synchronization

This module is separate from public catalog browsing and browser watch-progress events.

## Provider boundary

| Provider | Account login | List import | List writes | Notes |
| --- | --- | --- | --- | --- |
| YummyAnime | Available through the local API | Available through the local API | Available for status membership with an explicit list ID; favorites can be added independently, but removal is intentionally not automated yet | Requires a locally configured application token. |
| AnimeGO | Not verified | Not verified | Not verified | Public catalog support is not evidence of an account-list API. |
| Anixart | Not enabled | Not enabled | Not enabled | Available API documentation is unofficial and version-sensitive. |

## Safety rules

- Exact provider IDs are the only automatic identity matches.
- Fuzzy title matches are suggestions for user review, not automatic merges.
- Year and format mismatches suppress suggestions to reduce season/movie collisions.
- A missing remote row is never treated as a deletion.
- A provider write requires an explicit target list ID. The app does not guess a provider list/status mapping.
- The sync planner is pure and does not perform network writes. Callers must persist a new baseline only after every write succeeds and all conflicts are resolved.
- YummyAnime credentials are submitted only to the local API. The existing server stores access tokens in its encrypted local token store. Never log credentials or tokens.

## YummyAnime API prerequisites

Configure YUMMY_APPLICATION_TOKEN in .env.local. The local server provides login, token refresh, list retrieval, status-list mutation and favorite-add routes. Favorite removal is not automatically sent by the UI. The upstream API documentation marks the API for personal use; confirm permission with the API owner before distributing a commercial product.

## Remaining provider research

AnimeGO read-only list import now uses the authenticated profile DOM in the browser extension. It does not scrape cookies, submit credentials, or call private AJAX routes. Reverse writes remain disabled until the actual site mutation contract is verified. Anixart requires a maintained, permitted API contract and fixture coverage. CAPTCHA or anti-bot challenges must remain user-mediated and must not be bypassed.

## Eight implementation workstreams

1. Provider capability registry and adapter contract: implemented.
2. Exact ID resolution plus user-confirmed fuzzy title suggestions: implemented.
3. YummyAnime login, list import, mapped status writes and favorite-add writes: implemented. Progress/score writes and automatic favorite removal remain unsupported.
4. Anixart own-export import: implemented for CSV and legacy TXT. No account credentials or private API calls.
5. AnimeGO account-list read: implemented as a user-initiated browser-extension capture from the open profile page. It does not read cookies or credentials.
6. AnimeGO remote writes: blocked until a stable, permitted mutation contract is verified. No speculative AJAX mutations are sent.
7. Account/import UI: implemented for YummyAnime, AnimeGO profile capture and Anixart export preview.
8. Regression coverage and CI: passed on the latest PR commit. Runtime smoke tests against real user exports/profile pages remain to be performed by the user.

## AnimeGO profile import

1. Install/reload the browser extension from `browser-extension/`.
2. Sign in to AnimeGO normally in the browser.
3. Open one of your profile list pages: `/profile/<user>?type=1..6` or `/user/<user>?type=1..6`.
4. Click **Передать список в Mido** in the floating panel. The extension scrolls until the lazy-loaded list stabilizes, then opens the local app.
5. The app validates the sender, exact numeric AnimeGO IDs and list type, then merges provider source entries into IndexedDB. Repeat for other list types.

List type mapping follows the site's profile export structure: 1 watching, 2 completed, 3 on hold, 4 dropped, 5 planned, 6 rewatching. Import is read-only. Missing progress/favorite fields remain unknown and preserve existing AnimeGO source values. Invalid or duplicate rows are skipped; absent remote rows never delete local data.

The import payload is relayed through extension-local storage and a same-origin app bridge. No AnimeGO password, session cookie or auth token is copied to the local server.

## Anixart export import

1. In the Anixart app open **Settings → Data and memory → Export bookmarks**.
2. Choose **CSV table** or **Text document**. Include watch status and personal rating when the export options offer them.
3. Save the file and select it in the **Streaming accounts → Anixart** section in Mido.
4. Mido parses the export and opens the existing import preview. Review title matches before confirming the merge.

The parser supports Russian and English CSV column names and the legacy slash-delimited text export. When a stable Anixart release ID is present it is retained as an exact external ID. If the export contains titles only, deterministic provisional IDs are used. Mido displays fuzzy title candidates (with similarity percentages) as suggestions only; the user must select each merge explicitly, and duplicate target selections are rejected. Missing progress, score and favorite values remain unknown rather than being reset. Favorites-only rows without a watch status are skipped because the shared list model requires a status.

The mobile account API remains disabled. No password, token, cookie or private API request is used.
