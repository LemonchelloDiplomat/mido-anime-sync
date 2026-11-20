# AnixART website integration

The app now includes the public desktop website at https://anixart.site/ in Streaming catalogs. This is not an integration with the Android/iOS AnixART application.

## Supported capabilities

- Public website search.
- Public title cards and details (title, poster, synopsis, year, genres where present).
- Public dubbing/voice-team labels.
- Total episode count.
- Opening the original website page.

The current public HTML does not provide a complete season/episode manifest. The browser extension reads the selected season, episode, voice, and playback position from the desktop site's player state while the user watches, then sends a sanitized watch event to the local library.

## Account limitations

The website itself states that it is not connected to the AnixART mobile application and that mobile-app data is not shared with the website. Therefore:
- website login is not treated as mobile-app login;
- no mobile account import or sync is implemented;
- no passwords are sent to undocumented app endpoints;
- no reverse-engineered mobile API is used.

This is intentional. A similarly named website and mobile app are not assumed to share user accounts.

## Data safety and stability

- The adapter reads public HTML only.
- It does not extract video iframe URLs, stream URLs, signed tokens, or cookies.
- It does not write remote lists or watch progress.
- Watch progress comes from the existing browser extension and remains a separate AnixART source entry in the local library.
- Search and title pages are website interfaces, not a stable third-party API contract, and may change without notice.

Reference: https://anixart.site/7004-magicheskaja-bitva-2.html
