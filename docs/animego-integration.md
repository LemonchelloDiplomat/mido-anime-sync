# AnimeGO integration

This branch adds read-only public catalog support for AnimeGO.

## What is supported

- Search through the public website search page.
- Public title details and available structured metadata (JSON-LD).
- Public episode numbering/title metadata and dubbing labels from the site's player-page response.
- Opening the original AnimeGO title page.

The adapter deliberately does not extract player URLs, iframe URLs, signed media URLs, cookies, or playback tokens.

## Account and progress

No authoritative public AnimeGO account API has been verified. Account connection, personal-list import, and remote list writes are therefore disabled. The existing browser extension remains the source of watch-progress events from AnimeGO pages and sends those events to the local library as a separate source entry.

## Stability notes

AnimeGO does not publish a stable third-party API contract for these page structures. This adapter reads public HTML and the page's public episode metadata response. The site may change markup or routes without notice. A provider failure must not affect the local library or MAL/AniList/Shikimori synchronization.

References:
- Public AnimeGO search path: https://animego.org/search/anime?q=lain
- Existing community parser reference (not an official API contract): https://github.com/vypivshiy/anicli-api
