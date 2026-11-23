# AnimeGO account integration research

Research date: 2026-11-23

## Executive conclusion

AnimeGO does not expose a documented public OAuth/API contract for third-party account synchronization in the sources reviewed. However, there is recent community evidence that the website itself exposes authenticated list pages and same-origin form actions for list status changes and ratings.

This is enough to justify a controlled technical proof of concept, but not enough to mark account sync as supported. All discovered routes below are **unofficial / observed website behavior** and must be re-verified against the live site before implementation. Do not describe them as a public or official API.

The current application uses `https://animego.me` for catalog requests in `server/animego-routes.mjs`. Keep the account adapter restricted to that exact origin unless a separate mirror is deliberately added and reviewed.

## Evidence reviewed

1. The live AnimeGO homepage exposes a `/login` entry and describes the service as usable without registration for public viewing. The login page contains a username/email field, password field, remember-me checkbox and a standard submit button. This confirms a first-party website login UI, not a third-party API.
2. A Shikimori forum post dated 2025-10-28 contains a community userscript for exporting AnimeGO lists. Its author describes profile list pages at `/profile/*` and `/user/*`, separate list pages selected by `?type=N`, and a DOM list container `.user-mylist__item`. It scrolls the page until all list cards have loaded.
3. A forum comment dated 2026-09-16 reports the following observed website actions:
   - `POST /mylist/anime/{animeId}/{type}/add`
   - `GET /search/all?q={name}&navbar=true`
   - `POST /rating/anime/{animeId}/vote` with form fields `token` (CSRF token) and `rate` (1..10).
   The comment maps status values 1..6 to watching, completed, on hold, dropped, planned and rewatching. This is a user report, not vendor documentation.
4. The independent `anicli-api` project classifies AnimeGO catalog extraction as SSR/HTML parsing rather than a documented REST API. It is a third-party parser and explicitly describes the project as primarily personal-use / “as is”.
5. The independent `animego-console` project reports using user-provided credentials for some authenticated catalog behavior and stores them in a plaintext temp file. That storage approach is insecure and must not be copied. It is only supporting evidence that authentication has been attempted by third-party clients, not a recommended auth design.

## Candidate protocol map (unverified)

| Operation | Candidate website behavior | Confidence |
|---|---|---|
| Sign-in | First-party `GET /login` form, followed by form submission and session cookies | Low until form field names, CSRF and redirects are captured |
| Profile identity | Authenticated profile page under `/profile/*` or public user page under `/user/*` | Medium |
| Read list | Read each `/profile/{name}?type=N` page; parse `.user-mylist__item` cards | Medium for rendered DOM, low for server-side pagination |
| Map title | Card title href points to `/anime/{slug}-{id}`; numeric suffix is the AnimeGO ID | Medium |
| Search ID | `GET /search/all?q=...&navbar=true`, response reportedly contains `data.content` with title links | Low until live response is captured |
| Add/change status | `POST /mylist/anime/{id}/{type}/add`, type 1..6 | Low, community-reported |
| Rating | `POST /rating/anime/{id}/vote`, form fields `token` and `rate` | Low, community-reported |
| Remove from list | Not established by reviewed evidence | Unknown |
| Episode progress | Not established as a reliable account-list operation | Unknown |

Status mapping from the community report:
- 1 = watching
- 2 = completed
- 3 = on hold
- 4 = dropped
- 5 = planned
- 6 = rewatching

The list-export userscript maps the same six values and reads the score from `[data-rating-value]`. It does not establish a safe write contract for progress, deletion or bulk operations.

## Important architecture constraints

- The browser runtime must never receive or persist AnimeGO passwords, cookies, session IDs or CSRF tokens.
- Do not store passwords. At most, a verified sign-in flow may exchange a user-entered password once for a session, then discard the password.
- Store only the minimum session material needed, encrypted at rest. Prefer Windows Credential Manager / OS secure storage for the Windows desktop build. The browser-only development runtime needs an explicitly reviewed local secret-storage design before it can claim equivalent protection.
- Never log request bodies, cookies, Set-Cookie headers, CSRF tokens, passwords or full authenticated URLs.
- Restrict requests to HTTPS and the exact configured AnimeGO origin. Reject redirects to other origins; do not forward cookies across origins.
- Respect rate limits. Start with one request at a time and at least 1 second between requests; add backoff for 429/5xx.
- Do not bypass CAPTCHA, Cloudflare challenges, bot checks, access restrictions or account protections. If the website requires an interactive challenge, stop and ask the user to complete the first-party flow manually.
- The discovered endpoints are undocumented and may change. Every mutating operation must be behind a preview/confirmation step and have an explicit read-back verification.
- Do not claim official API support or promise long-term compatibility.

## Recommended implementation sequence

### Phase A: protocol verification, read-only first
1. Inspect the live login form's exact method, action, input names, hidden CSRF fields, cookies, redirect chain and any challenge behavior.
2. Sign in manually with a test account in a user-controlled first-party browser window. Do not ask for or store the user's password during protocol research.
3. Capture only redacted network metadata: method, path, status, content type, safe response shape and cookie names/attributes. Never collect cookie values.
4. Inspect profile pages for each status and determine whether the full list is server-rendered, paginated, or loaded through an XHR/fetch endpoint.
5. Build HTML fixtures from redacted/synthetic responses and test parsing without requiring a live account.
6. Implement account status + profile identity + read-only list import only after the session boundary and pagination behavior are proven.

### Phase B: safe writes
1. Verify status change, rating update and removal independently against a test account.
2. Confirm required CSRF token source, form encoding, redirect/result semantics and read-back behavior.
3. Add a dry-run diff preview and require explicit user confirmation before writes.
4. Add per-operation throttling, idempotency guards, retries only for safe transient failures, and audit events that omit secrets.
5. Keep episode progress disabled unless a separate reliable account operation is demonstrated.

### Phase C: product integration
1. Map AnimeGO numeric IDs to the app's canonical anime identity without title-only automatic merges.
2. Preserve unmatched and ambiguous rows for manual matching.
3. Add import preview, duplicate detection, conflict policy and rollback-safe local transactions.
4. Add capability flags only after end-to-end tests pass.

## Immediate next engineering task

Create a disposable protocol-inspection harness (tests + fixture parser) that does not submit credentials or mutate an account. Its first deliverable should establish:
- exact list card selectors and ID extraction;
- exact status page route shape and pagination mechanism;
- whether authenticated list HTML can be consumed by the local Node service without a browser extension;
- the exact login form structure, without retaining any user secrets.

Do not implement the community-reported POST routes yet. The current status-only `/api/streaming/accounts/animego/*` routes should remain unsupported until the read-only session flow is verified.

## Sources

- AnimeGO homepage: https://animego.me/
- AnimeGO login page: https://animego.me/login
- Community list export and endpoint discussion (post 2025-10-28; comment 2026-09-16): https://shikimori.io/forum/site/609251-eksport-spiska-s-animego-na-shikimori
- Third-party parser project: https://github.com/vypivshiy/anicli-api
- Third-party console client: https://github.com/PrimoTibalt/animego-console
