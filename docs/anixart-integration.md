# AnixART website integration

The app integrates the public desktop website at https://anixart.site/. This is not an integration with the AnixART Android/iOS application.

## Supported capabilities

- Public website search.
- Public title cards and details (title, poster, synopsis, year, genres where present).
- Full season, episode, and voice catalog fetched directly by the local server from the public CVH playlist API.
- Local interface display of seasons and expandable episode rows with voice names and types.
- Watch-progress events through the existing browser extension. The extension is not required for catalog search, title details, seasons, episodes, or voices.
- Opening the original website page.

The local server reads the public player metadata attributes data-title-id, data-publisher-id, and optional data-aggregator from the title page, then requests the corresponding playlist from plapi.cdnvideohub.com. Only season/episode numbers, episode names, voice names, and voice types are returned to the app. CVH video identifiers and transient stream URLs are not persisted or exposed in the catalog response.

The first direct-server implementation retrieves catalog metadata. Selecting an episode or voice and resolving a playable stream into the app's own video player are separate follow-up tasks. Until then, the voice row links to the original AnixART title page for playback.

## Account limitations

The website itself states that it is not connected to the AnixART mobile application and that mobile-app data is not shared with the website. Therefore:
- website login is not treated as mobile-app login;
- no mobile account import or sync is implemented;
- no passwords are sent to undocumented app endpoints;
- no reverse-engineered mobile account API is used.

## Data safety and stability

- The adapter reads public website HTML and the public CVH playlist endpoint.
- CVH vkId values and returned video stream URLs are not stored in the local library or exposed to the browser UI.
- No credentials, cookies, or signed playback URLs are persisted.
- Watch progress remains a separate AnixART source entry and still uses the existing browser extension.
- Website markup and the CVH playlist response are not a stable third-party API contract and may change without notice.

Reference: https://anixart.site/7004-magicheskaja-bitva-2.html
