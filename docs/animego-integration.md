# AnimeGO integration

This branch supports AnimeGO's public catalogue and lazy per-episode player discovery.

## What is supported

- Search through the public website search page.
- Public title details and structured metadata (JSON-LD).
- Public episode numbering and titles.
- On-demand loading of the selected episode's available dubbing/player variants.
- Embedded playback when the third-party player permits iframe embedding, with a separate-tab fallback.
- Opening the original AnimeGO title page.

AnimeGO's player endpoint is requested with the same XHR and Referer headers used by its public web player. Episode player lists are fetched only when a user expands that episode, rather than making one request for every episode when opening a title.

The adapter stores the provider's embed URL in transient UI state only. It does not resolve media manifests, download video, or persist player URLs in the local library.

## Account and progress

AnimeGO does not publish a documented public third-party account API. Windows account sign-in is performed in the first-party site through Tauri WebView2. The resulting cookies are kept in Rust and Windows Credential Manager; they are never sent to React, the local Node API, IndexedDB, or the library.

The Windows native adapter reads the six personal-list categories from signed-in profile pages (/profile/{userId}?type=1..6, with /user/{userId} as a route fallback). Lazy pages are requested through the site's Turbo Frame URLs under /user/mylist/{listId}/{page}?type={type}. The parser extracts exact AnimeGO IDs, titles, poster URLs, release labels, and episode progress when the page exposes it. Requests are sequential, same-origin only, bounded by response/page/item limits, and do not bypass CAPTCHA or anti-bot checks.

The local import normalizer maps the six list types to the app's existing statuses and stores AnimeGO as a separate source entry. Re-import preserves existing provider progress, score, and favorite values when the current response does not expose those fields. The account adapter now supports first-party list writes for status changes (`POST /mylist/anime/{animeId}/{listType}/add`) and deletion (`POST /mylist/anime/{animeId}/delete`), using the CSRF field and cookies from the authenticated session. The existing rating write remains separate. Each operation re-reads the account lists to verify persistence; a successful HTTP response alone is not considered confirmation. Episode-progress writes are not yet implemented: the observed `/player/videos/{videoId}` GET request only loads player data and does not establish a write contract. This is first-party page interaction, not an official public API, and site markup/routes may change.

The existing browser extension remains an additional source of watch-progress events from AnimeGO pages and sends those events to the local library as a separate source entry. This is currently an inbound progress signal, not a confirmed remote progress-write endpoint. Android account sign-in/list import remains deferred until a dedicated Android WebView cookie adapter is implemented.

## Network compatibility

The adapter uses the current `animego.me` domain. Its server-side HTTPS client resolves the domain through Cloudflare DNS (1.1.1.1), with Google DNS (8.8.8.8) as a fallback, then connects using the resolved IPv4 address while preserving the original hostname for TLS SNI and the HTTP Host header. This avoids relying on a Windows system DNS result that may incorrectly return `0.0.0.0`. The resolved address is cached for five minutes and is not hardcoded.

## Supported account writes\n\n- Rating: existing native write flow, verified by re-reading the title rating.\n- Status: confirmed first-party route, list type mapping 1 watching, 2 completed, 3 on hold, 4 dropped, 5 planning, 6 rewatching.\n- Delete: confirmed first-party route, verified by checking that the AnimeGO ID is absent from all six account lists.\n- Progress: remote write endpoint not yet identified. Do not treat player metadata GET requests as progress writes.\n\n## Stability notes

AnimeGO does not publish a stable third-party API contract for these page structures. The adapter reads public HTML and the site's public XHR player responses. The site may change markup or routes without notice. A provider failure must not affect the local library or MAL/AniList/Shikimori synchronization.

Some third-party players may independently block iframe embedding, require cookies, or report that a particular video is unavailable. In those cases the UI offers the provider embed in a separate tab.

References:
- Public AnimeGO search path: https://animego.me/search/anime?q=lain
- AnimeGO community parser reference: https://github.com/ialakey/anime-dl-core
