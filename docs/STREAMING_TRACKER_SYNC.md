# Streaming account list synchronization

This module is separate from public catalog browsing and browser watch-progress events.

## Provider boundary

| Provider | Account login | List import | List writes | Notes |
| --- | --- | --- | --- | --- |
| YummyAnime | Available through the local API | Available through the local API | Available when the user explicitly chooses a target list ID | Requires a locally configured application token. |
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

Configure YUMMY_APPLICATION_TOKEN in .env.local. The local server already provides login, token refresh, list retrieval and list mutation routes. The upstream API documentation marks the API for personal use; confirm permission with the API owner before distributing a commercial product.

## Remaining provider research

AnimeGO account integration requires verified login, CSRF/cookie handling and list AJAX contracts. Anixart requires a maintained, permitted API contract and fixture coverage. CAPTCHA or anti-bot challenges must remain user-mediated and must not be bypassed.
