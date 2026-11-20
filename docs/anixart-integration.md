# AnixART website integration

The app integrates the public desktop website at https://anixart.site/. This is not an integration with the AnixART Android/iOS application.

## Supported capabilities

- Public website search.
- Public title cards and details (title, poster, synopsis, year, genres where present).
- Full season, episode, and voice catalog fetched directly by the local server from the public CVH playlist API.
- Local interface display of seasons and expandable episode rows with voice names and types.
- Watch-progress events through the existing browser extension. The extension is not required for catalog search, title details, seasons, episodes, or voices.
- Opening the original website page.
- Resolving a selected voice's CVH video metadata on demand.
- Playing CVH MP4 sources in the app's HTML5 video player through a local byte-range-aware proxy.

The local server reads the public player metadata attributes data-title-id, data-publisher-id, and optional data-aggregator from the title page, then requests the corresponding playlist from plapi.cdnvideohub.com. Each voice row receives a temporary local playback route based on its CVH video id. When playback starts, the server requests /player/sv/video/<vkId>, selects the highest available MP4 source, and proxies the media bytes with Range/Content-Range support and the required player Referer. Signed CDN URLs are not sent to the browser or persisted.

The proxy currently targets CVH MP4 variants. If a title only exposes HLS/DASH and no MP4 source, playback returns a clear error rather than showing a broken player.

## Account limitations

The website itself states that it is not connected to the AnixART mobile application and that mobile-app data is not shared with the website. Therefore:
- website login is not treated as mobile-app login;
- no mobile account import or sync is implemented;
- no passwords are sent to undocumented app endpoints;
- no reverse-engineered mobile account API is used.

## Data safety and stability

- The adapter reads public website HTML and the public CVH playlist endpoint.
- CVH video ids are used only in temporary local playback routes and are not stored in the local library. Signed CDN stream URLs remain server-side and are not exposed to the browser UI.
- No credentials, cookies, or signed playback URLs are persisted.
- Watch progress remains a separate AnixART source entry and still uses the existing browser extension.
- Website markup and the CVH playlist response are not a stable third-party API contract and may change without notice.

Reference: https://anixart.site/7004-magicheskaja-bitva-2.html
