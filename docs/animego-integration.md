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

No authoritative public AnimeGO account API has been verified. Account connection, personal-list import, and remote list writes remain disabled. The existing browser extension remains the source of watch-progress events from AnimeGO pages and sends those events to the local library as a separate source entry.

## Network compatibility

The adapter uses the current `animego.me` domain. Its server-side HTTPS client resolves the domain through Cloudflare DNS (1.1.1.1), with Google DNS (8.8.8.8) as a fallback, then connects using the resolved IPv4 address while preserving the original hostname for TLS SNI and the HTTP Host header. This avoids relying on a Windows system DNS result that may incorrectly return `0.0.0.0`. The resolved address is cached for five minutes and is not hardcoded.

## Stability notes

AnimeGO does not publish a stable third-party API contract for these page structures. The adapter reads public HTML and the site's public XHR player responses. The site may change markup or routes without notice. A provider failure must not affect the local library or MAL/AniList/Shikimori synchronization.

Some third-party players may independently block iframe embedding, require cookies, or report that a particular video is unavailable. In those cases the UI offers the provider embed in a separate tab.

References:
- Public AnimeGO search path: https://animego.me/search/anime?q=lain
- AnimeGO community parser reference: https://github.com/ialakey/anime-dl-core
