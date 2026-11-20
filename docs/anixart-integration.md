# AnixART website integration

The app includes the public desktop website at https://anixart.site/ in Streaming catalogs. This is not an integration with the AnixART Android/iOS application.

## Supported capabilities

- Public website search.
- Public title cards and details (title, poster, synopsis, year, genres where present).
- Public dubbing/voice-team labels and total episode count.
- Full season/episode/voice catalog captured from the desktop website player after the user opens a title and the player state becomes available.
- Local interface display of seasons, episodes, voice names and voice types.
- Current season, episode and selected voice indicator.
- Opening the original website page.
- Watch progress events through the browser extension.

The public HTML alone does not provide a complete season/episode manifest. The browser extension reads the structured `video-player.state.seasons` object from the page player, strips player/video identifiers and URLs, and forwards only season numbers, episode numbers, voice names/types and current selection to the local server. The local interface polls this short-lived catalog cache while an AnixART title is selected.

## Account limitations

The website itself states that it is not connected to the AnixART mobile application and that mobile-app data is not shared with the website. Therefore:
- website login is not treated as mobile-app login;
- no mobile account import or sync is implemented;
- no passwords are sent to undocumented app endpoints;
- no reverse-engineered mobile API is used.

This is intentional. A similarly named website and mobile app are not assumed to share user accounts.

## Data safety and stability

- The adapter reads public HTML only.
- The extension does not extract or forward `cvhId`, `vkId`, video iframe URLs, stream URLs, signed tokens, or cookies.
- Catalog data is held in local memory for up to 10 minutes and is not persisted to the library.
- Watch progress comes from the existing browser extension and remains a separate AnixART source entry in the local library.
- Selecting an episode/voice and in-app playback are not yet implemented; playback selection remains on the AnixART website.
- Search, title pages and player state are website interfaces, not a stable third-party API contract, and may change without notice.

Reference: https://anixart.site/7004-magicheskaja-bitva-2.html
