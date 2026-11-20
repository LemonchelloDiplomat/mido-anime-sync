# Streaming provider integration plan

This document describes the boundary between catalog providers (MAL, AniList, Shikimori)
and streaming providers (AnimeGO, YummyAnime, AnixART).

## Product goals

Each streaming provider may independently expose:
- catalog search and title details;
- seasons, episodes, and voice tracks;
- account connection and personal-list import;
- watch-history import and progress updates.

A capability must remain disabled until its adapter and tests demonstrate that the
provider supports it. A website integration that only emits browser watch events
must not be presented as account synchronization.

## Architecture

- `src/services/streaming-provider.ts` defines provider-neutral contracts.
- Catalog and account adapters are separate interfaces. A provider may implement
  one without implementing the other.
- Streaming progress is mapped to the existing `AnimeSourceEntry` model using
  the provider's existing `ServiceId`. It must not overwrite MAL, AniList,
  Shikimori, or local entries.
- Matching external titles to the local library must use verified external IDs
  when available. Title-only matches remain suggestions and ambiguous matches
  require user confirmation.
- Credentials and access tokens must stay in the local server's encrypted token
  store. Never expose credentials to browser content scripts or UI state.
- Do not persist signed media URLs, player tokens, cookies, or other transient
  playback secrets.

## Provider research and implementation order

### YummyAnime

The public API documentation at https://api.yani.tv/ describes catalog/search,
anime details and videos, user authorization, user lists, and video watch-history
operations. It states that application access requires an application token,
that the API is for personal use unless commercial permission is obtained, and
that user tokens expire and need refreshing.

Implementation order:
1. Confirm the exact response schemas and pagination for search, details, episodes,
   voices, lists, and watch history.
2. Implement read-only catalog access and map results to provider-neutral types.
3. Add local-server account authorization and encrypted token storage.
4. Implement list/watch-history import first; only then consider remote writes.
5. Add contract tests using sanitized fixtures, rate limits, and explicit error
   handling for captcha/authorization failures.

Reference: https://api.yani.tv/
Related project reference: https://github.com/yummyanime/yummy-lampa-plugin

### AnimeGO

No authoritative public API documentation has been verified yet. Begin with
public website behavior and existing browser-extension observations. Do not assume
that internal endpoints are stable or permitted for third-party use.

Implementation order:
1. Identify public search, title, season, episode, and voice data exposed by the
   website without extracting protected media URLs.
2. Prefer stable public page metadata and canonical URLs.
3. Treat account/list synchronization as unsupported until a documented or
   otherwise authorized interface is verified.
4. Preserve the existing browser watch-event integration independently.

### AnixART

The desktop website integration already emits watch events. That does not imply
that the desktop website exposes an official account API.

Publicly available API references are unofficial/reverse-engineered. One archived
client explicitly warns that AnixART has no official API and that third-party use
may be restricted. Do not implement password login against undocumented endpoints
or distribute reverse-engineered API details as a stable contract.

Implementation order:
1. Build public desktop-site catalog support only where the website exposes
   stable, public data.
2. Reuse the existing browser watch-event path for progress capture.
3. Keep personal-list import/account sync disabled until a supported interface
   and its security implications are verified.

References:
- https://github.com/Nekonyx/anixart-api
- https://openanix.ru/anixart-api-docs/

## Safety and data-integrity requirements

- Never silently merge anime based on a fuzzy title match.
- Never overwrite progress from another provider.
- Preserve higher progress and newer timestamps when applying imported events.
- Make destructive remote operations opt-in and separately confirmed.
- Do not store passwords. Use supported token flows and encrypted local storage.
- Provider failures must not block the local library or other provider syncs.
