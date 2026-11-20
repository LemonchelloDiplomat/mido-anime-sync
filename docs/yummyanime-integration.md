# YummyAnime integration

This branch adds a local-server adapter for the official YummyAnime API.

## Setup

1. Create a personal-use developer application at https://yummyani.me/dev/applications.
2. Copy its public application token into `.env.local` as `YUMMY_APPLICATION_TOKEN`.
3. Restart the local API server.
4. Connect an account through `POST /api/yummyanime/login`. The password is used only for the login request and is never persisted. The returned Bearer token is stored in the existing AES-256-GCM encrypted local token file.

The API owner documents the API as personal-use only. Commercial use requires permission from YummyAnime. Do not publish the application token or use this integration in a hosted multi-user service without authorization.

## Local API routes

| Route | Purpose |
| --- | --- |
| `GET /api/yummyanime/status` | Application configuration and connection status, without returning tokens |
| `POST /api/yummyanime/login` | Login; returns an explicit hCaptcha challenge when the API responds with HTTP 420 |
| `POST /api/yummyanime/logout` | Revoke the remote session and clear the local token |
| `GET /api/yummyanime/search?q=...` | Public catalog search |
| `GET /api/yummyanime/anime/:id` | Title details plus episode/dubbing metadata |
| `GET /api/yummyanime/profile` | Current account profile |
| `GET /api/yummyanime/lists` | Read all available user lists |
| `GET /api/yummyanime/history` | Read account watch history |
| `POST /api/yummyanime/list` | Explicitly change a title's list |
| `POST /api/yummyanime/progress` | Explicitly update one episode's watch position |

## Data integrity and security

- The account Bearer token stays in the local server's encrypted token store. It is never returned by the status endpoint or sent to React state.
- The password is not stored.
- hCaptcha/HTTP 420 is surfaced to the client; the server does not retry a blocked login automatically.
- List import and watch-history import are separate from remote writes.
- The parser creates YummyAnime-owned identities and source entries. It does not overwrite MAL, AniList, Shikimori, or local entries.
- Anime matching must use exact external IDs. Title-only matches are suggestions, not automatic merges.
- Episode parsing keeps episode IDs, numbering and dubbing names only. It deliberately discards iframe/player URLs and does not resolve or persist media streams.
- Progress import is read-only. Remote list/progress writes are separate explicit operations.

## Provider support

| Capability | Status |
| --- | --- |
| Search | Implemented |
| Title details | Implemented |
| Episodes and dubbing labels | Implemented |
| Account connection | Implemented through local server; requires the user's application token |
| Personal-list read | Implemented |
| Watch-history read | Implemented |
| List write | Implemented as an explicit API operation |
| Watch-progress write | Implemented as an explicit API operation |
| Captcha login | Challenge is detected and returned; interactive captcha UI remains a follow-up |

References:
- Official API documentation: https://api.yani.tv/
- Official YummyAnime Lampa plugin and anonymized API fixtures: https://github.com/yummyanime/yummy-lampa-plugin
- API client reference: https://github.com/IM1corp/YummyAPI
