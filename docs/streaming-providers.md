# Streaming provider integrations

Catalog providers (MAL, AniList, Shikimori) and streaming websites (YummyAnime, AnimeGO, AnixART) are separate integration families. Streaming sites provide viewing pages and may provide catalog/account data; they are not assumed to support the same synchronization operations as catalog services.

## App architecture

- `src/services/streaming-provider.ts` defines provider-neutral catalog/account contracts.
- `src/services/yummyanime.ts`, `animego.ts`, and `anixart.ts` implement provider clients.
- Local-server routes proxy website requests and keep account tokens away from browser UI.
- The Streaming catalogs panel is integrated into the app search screen.
- Streaming progress is mapped to the existing source-entry model using the provider's `ServiceId`. It does not overwrite MAL, AniList, Shikimori, or local entries.
- Exact shared external IDs may reconcile imported account records with the existing library. Title-only and ambiguous matches remain separate.
- Signed media URLs, iframe URLs, player tokens, cookies, and other transient playback secrets are not stored.

## Current provider capabilities

| Provider | Search/details | Episodes/voices | Account lists/history | Progress |
| --- | --- | --- | --- | --- |
| YummyAnime | Yes | Yes | Yes, via official personal-use API | Import supported; explicit remote API operations |
| AnimeGO | Public website pages | Public episode metadata and dubbing labels | No verified account API | Existing browser extension |
| AnixART desktop site | Public website pages | Full seasons, episodes, voice variants, and CVH MP4 playback through local proxy | No mobile-account sync; site says it is separate from app | Existing browser extension for playback progress only |

## YummyAnime

Official API documentation: https://api.yani.tv/. The API requires an application token, is personal-use only unless commercial permission is obtained, and supports account authorization, lists, and watch history. The app stores the user's Bearer token in the encrypted local server token store. Passwords are not persisted. hCaptcha/HTTP 420 is detected, but the current UI does not embed the hCaptcha widget.

## AnimeGO

No authoritative public account API has been verified. The adapter reads public site HTML and the page's episode metadata response. It deliberately ignores player/stream URLs. Website markup may change without notice.

## AnixART

This integration targets https://anixart.site/ only. The website states that it is not connected to the mobile AnixART application. No mobile app credentials or reverse-engineered mobile API are used. The local server reads public title metadata and requests the public CVH playlist using the player identifiers embedded in the title page. It maps seasons, episodes, and voice variants without requiring the browser extension. The extension remains optional for watch-progress events only. Selected CVH voice tracks resolve through the public video metadata endpoint and play as MP4 through the local server's Range-aware proxy; signed CDN URLs are not exposed to the browser.

## Safety and data-integrity requirements

- Never silently merge based on fuzzy title matching.
- Never overwrite another provider's source entry.
- Keep provider-specific errors isolated from local library and other integrations.
- Make remote writes explicit and separately confirmed.
- Do not store passwords or transient playback secrets.
