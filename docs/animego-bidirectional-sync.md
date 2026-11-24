# AnimeGO bidirectional synchronization

## Branch scope

This branch builds on the AnimeGO Windows WebView2 connection and read-only account import already present in the stacked PR chain. The local library remains authoritative and must remain usable offline.

This document records the first reverse-engineering checkpoint. It intentionally separates community-reported website actions from behavior verified by this application. No remote write is enabled by this document.

## Existing read path

The native Windows adapter stores AnimeGO cookies and account identity in Windows Credential Manager. The renderer receives parsed account-list data only. The current account-list command reads all six list categories, including list-entry IDs, AnimeGO IDs, progress, and personal score. It validates the authenticated account before returning data.

The current read operation is implemented by `animego_account_list_fetch` in `src-tauri/src/commands.rs`.

## Publicly reported write routes (unverified by this application)

A community post on Shikimori, updated with a comment dated 16 September 2026, reports the following AnimeGO website requests:

- Add an anime to a list: `POST /mylist/anime/{animeId}/{listType}/add`
- Vote for an anime: `POST /rating/anime/{animeId}/vote`, with multipart fields `token` (CSRF token) and `rate` (integer 1–10).
- List type mapping: 1 watching, 2 completed, 3 on hold, 4 dropped, 5 planned, 6 rewatching.
- AnimeGO IDs can be resolved from the site's search response at `/search/all?q={name}&navbar=true`.

Source: https://shikimori.io/forum/site/609251-eksport-spiska-s-animego-na-shikimori (community post and comments, lines 464–498).

These are third-party observations, not an official AnimeGO API contract. The app must not assume that the routes remain stable or that a successful HTTP response means the account state changed.

## Unknowns that must be established before enabling writes

1. Whether the add route is also an upsert when the title already belongs to a list, or whether it creates duplicates / returns a conflict.
2. Whether moving between statuses requires a dedicated remove or edit operation before adding to the new list.
3. The supported way to remove a title from the account entirely.
4. Whether progress has a separate endpoint, or is changed by controls on the title page; exact request body and CSRF requirements are unknown.
5. How the CSRF token is supplied and refreshed in the authenticated WebView2 session.
6. Whether rating can be cleared, and how an existing rating is updated.
7. Which HTTP status and response body reliably confirm each mutation.

No guessed route, payload, token selector, or response interpretation may be used for a production write.

## Current implementation checkpoint

Branch 59 includes the native read-only command `animego_account_write_inspect`, registered in the Tauri command handler and exposed through the Windows account manager panel after a list preview has been loaded. The panel inspects the first imported title as a sample. It reports form methods, same-origin action paths, safe encoding metadata, field names/types/required flags, coarse purpose labels, relevant DOM controls, same-origin script paths, and static inline-script keyword hints. It also fetches at most eight same-origin `/build/` JavaScript bundles, with a 2 MB per-response limit and a short delay, and statically extracts sanitized relative route candidates plus coarse method/capability/field hints. It never executes scripts or returns source code, field values, cookies, or tokens, and performs no POST/PUT/DELETE requests.


## Windows live inspection checkpoint (25 November 2026)

The read-only inspection was run in the connected Windows app against an authenticated account page. It found four same-origin forms:

| Method | Action path | Field names | Interpretation |
| --- | --- | --- | --- |
| POST | `/logout` | `_csrf_token` | Logout form; explicitly excluded from write capabilities |
| POST | `/logout` | `_csrf_token` | Duplicate logout form; explicitly excluded from write capabilities |
| POST | `/rating/anime/694/vote` | `token`, `rate` | Live-observed rating form for sample AnimeGO ID 694 |
| GET | `/search/all` | `q` | Search form; read-only lookup |

No CSRF meta fields were found. The logout forms show a hidden field named `_csrf_token`; the rating form exposes a field named `token`. The inspection deliberately did not return either field's value, submit a form, or change the account.

This confirms the existence and shape of the rating form only. It does **not** yet confirm the encoding, token source/value, update semantics, success response, or read-back behavior. Do not enable rating writes until those are validated safely. The search form is not a mutation capability. No status-change, progress-update, or remove form was found in this inspection.

Next validation:
1. Inspect the rating form's encoding and safe control metadata without returning values.
2. Determine how the page populates/refreshes the `token` field, keeping token values inside Rust and never exposing them to React or logs.
3. Inspect a title already in the user's list to identify status/progress controls and their request metadata without submitting them.
4. Confirm any candidate operation only with a user-approved, reversible test and verify by re-reading the list.


## Expanded static inspection checkpoint

The native parser now also reports:

- Form encoding from the allowlisted values `application/x-www-form-urlencoded`, `multipart/form-data`, and `text/plain`; unexpected values are reduced to `other`.
- Named form controls with tag, normalized input type, and required flag. Field values are never returned.
- A coarse form purpose (`logout`, `rating`, `list`, or `unknown`) derived only from the same-origin action path. This is descriptive metadata, not authorization to write.
- Relevant controls whose identifiers suggest status, progress, episodes, list membership, rating, vote, or watch actions. Only sanitized identifiers and boolean handler-presence flags are returned.
- Same-origin script paths and a fixed vocabulary of inline-script keyword hints. Script source and handler bodies are never returned.
- A bounded static scan of up to eight same-origin `/build/` bundles. It reports sanitized relative route candidates, nearby HTTP-method hints, capability keywords, and a fixed allowlist of possible field names. It does not execute JavaScript, evaluate handlers, or send discovered requests. Method hints are heuristic and must be independently verified.

Static HTML cannot reveal event listeners attached later by external JavaScript or prove what a handler sends at runtime. The bundle scanner is deliberately heuristic: it can miss dynamically assembled routes, and nearby text can cause a method or field hint to be associated with the wrong route. Returned paths are candidates only, not confirmed endpoints or payload contracts. Script bodies are analyzed in Rust and discarded; only sanitized path literals and fixed vocabulary hints reach the UI. Off-origin forms and script URLs remain excluded. The inspection still performs no mutation requests.

## Implementation sequence

### Phase A: inspect and validate

- Add a native, read-only inspection path that uses the existing protected session.
- Inspect only first-party pages and forms for the authenticated user and the selected AnimeGO title.
- Return sanitized form metadata (method, same-origin action, field names, and non-secret capability flags). Never return cookies, CSRF values, or hidden session material to React.
- Add fixture-based parser tests and Windows live-test instructions.
- Do not send mutation requests in this phase.

### Phase B: guarded writes

Only after a route and payload are confirmed against the live website:

- Keep all authenticated HTTP and CSRF handling in Rust.
- Restrict requests to HTTPS `animego.me`, same-origin redirects, bounded body/response sizes, and a strict method/path allowlist.
- Require explicit user confirmation for each batch. Show the exact number of titles and fields to be changed.
- Apply one mutation at a time, verify the result by re-reading the account list, and stop on the first ambiguous response.
- Never log cookies, CSRF tokens, request bodies containing secrets, or full authenticated HTML.

### Phase C: reconciliation

- Compare local AnimeGO source entries with a freshly fetched remote snapshot.
- Use stable AnimeGO IDs for identity; do not match by title alone when an external ID is absent.
- Distinguish an absent field from an explicit empty value. Unknown remote progress or score must never erase known local values.
- Treat simultaneous local and remote changes as conflicts. Do not use `updatedAt` from unrelated clocks as proof of ordering.
- Do not propagate deletions automatically. A remote deletion requires an explicit deletion intent and confirmation.
- Preserve the existing offline-first library and queue only explicitly approved remote operations.

## Initial capability matrix

| Field / operation | Read | Write |
| --- | --- | --- |
| List status | Yes, via six list categories | Candidate route reported; not verified |
| Episode progress | Yes, when exposed in list card | Unknown |
| Personal score | Yes, when exposed in list card | Candidate vote route reported; not verified |
| Favorite | Not yet confirmed by the current account-list response | Unknown |
| Remove from account | Not established | Unknown |
| Account identity | Yes | Not applicable |

## Acceptance criteria

- No mutation is sent during account connection, import, or background refresh.
- A remote write is enabled only after a Windows live test confirms the request and the subsequent read-back.
- Failed or ambiguous writes leave local data untouched and are reported per title.
- Re-import remains safe and idempotent.
- All six status categories continue to import correctly.
- Existing snapshot versions remain backward-compatible; any new sync metadata must be optional and covered by migration tests.
