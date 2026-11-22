# Streaming provider integrations

Catalog providers (MAL, AniList, Shikimori) and streaming websites (YummyAnime, AnimeGO, AnixART) are separate integration families. The account-connections screen uses the same row layout for all six services, but only displays actions that have a working implementation.

## App architecture

- `src/services/streaming-provider.ts` defines provider-neutral catalog/account contracts.
- `src/services/yummyanime.ts`, `animego.ts`, and `anixart.ts` implement catalog clients.
- Local-server routes proxy website requests and keep account tokens away from browser UI.
- The Streaming catalogs panel is integrated into the app search screen.
- Streaming progress is mapped to the existing source-entry model using the provider's `ServiceId`. It does not overwrite MAL, AniList, Shikimori, or local entries.
- Exact shared external IDs may reconcile imported account records with the existing library. Title-only and ambiguous matches remain separate.
- Signed media URLs, iframe URLs, player tokens, cookies, and other transient playback secrets are not stored.

## Current provider capabilities

| Provider | Search/details | Episodes/voices | Account lists | Remote writes | Watch progress |
| --- | --- | --- | --- | --- | --- |
| YummyAnime | Yes | Yes | Import supported via API | Status-list mapping and favorite add | Account progress not currently confirmed |
| AnimeGO | Public website pages | Public episode metadata and dubbing labels | No verified account API | Not available | Browser extension events only |
| AnixART desktop site | Public website pages | Full seasons, episodes, voice variants, and CVH MP4 playback through local proxy | No supported mobile-account API | Not available | Browser extension events only |

## YummyAnime

Official API documentation: https://api.yani.tv/. The API requires an application token and is documented as personal-use only unless commercial permission is obtained. The app stores the user's Bearer token in the encrypted local server token store. Passwords are not persisted. The current integration imports lists and writes explicitly mapped status lists and favorite additions. Watched-episode progress is not currently confirmed by live account responses and must not be shown as synchronized.

## AnimeGO

No authoritative public account API has been verified. The adapter reads public site HTML and the page's episode metadata response. The browser extension can capture viewing events from supported pages, but this is not account-list import or remote synchronization. Website markup may change without notice.

## AnixART

This integration targets the public desktop website at https://anixart.site/ for catalog and playback only. The official app FAQ documents bookmark export as CSV or TXT, but that is not a direct API. An unofficial API client explicitly warns that Anixart does not publish an official API and does not permit third-party API use. Therefore the account connection, list import, and remote write controls remain unavailable until Anixart provides a supported API or written permission. The browser extension's watch events are separate from mobile-account synchronization.

## Safety and data-integrity requirements

- Never silently merge based on fuzzy title matching.
- Never overwrite another provider's source entry.
- Keep provider-specific errors isolated from local library and other integrations.
- Make remote writes explicit and separately confirmed.
- Do not store passwords or transient playback secrets.
- Never label a catalog scraper or browser event bridge as account API synchronization.
