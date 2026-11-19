# MidaHoshi Anime Sync

Локальная аниме-библиотека с каталогом AniList, импортом и двусторонней синхронизацией MyAnimeList, AniList и Shikimori.

## Требования

- Node.js 22+
- npm 10+

## Установка и запуск (Windows PowerShell)

~~~powershell
npm install
Copy-Item .env.example .env.local
npm run typecheck
npm test
npm run dev
~~~

Открой адрес Vite из терминала (обычно http://127.0.0.1:5173). Команда `npm run dev` запускает frontend и локальный API-сервер вместе. API по умолчанию слушает только `127.0.0.1:3001`.

## Подключение аккаунтов

Для каждого сервиса создай OAuth-приложение и укажи соответствующий redirect URL.

### MyAnimeList

1. Зарегистрируй приложение: https://myanimelist.net/apiconfig
2. Redirect URL: `http://127.0.0.1:3001/api/auth/mal/callback`
3. Заполни `MAL_CLIENT_ID` и при наличии `MAL_CLIENT_SECRET` в `.env.local`.

### AniList

1. Создай приложение: https://anilist.co/settings/developer
2. Redirect URL: `http://127.0.0.1:3001/api/auth/anilist/callback`
3. Заполни `ANILIST_CLIENT_ID` и `ANILIST_CLIENT_SECRET` в `.env.local`.

### Shikimori

1. Создай OAuth-приложение: https://shikimori.io/oauth/applications
2. Redirect URL: `http://127.0.0.1:3001/api/auth/shikimori/callback`
3. Разреши приложению изменять личный список аниме. Интеграция запрашивает scope `user_rates`.
4. Заполни `SHIKIMORI_CLIENT_ID` и `SHIKIMORI_CLIENT_SECRET` в `.env.local`.
5. Для запросов API передаётся User-Agent из `SHIKIMORI_USER_AGENT`; значение по умолчанию уже задано в `.env.example`.

Не отправляй Client Secret, access token или refresh token в чат и не добавляй их в Git. Файл `.env.local` и папка `.local-data` исключены из Git.

## Локальная безопасность

- API по умолчанию привязан к `127.0.0.1`, а не доступен всей локальной сети.
- OAuth-токены хранятся в `.local-data/tokens.enc.json` и шифруются AES-256-GCM отдельным локальным ключом.
- MAL OAuth использует PKCE; обмен кода на токен выполняет локальный сервер.
- AniList и Shikimori используют Authorization Code Grant; секреты и обмен токенов остаются на локальном сервере.
- Refresh-токены MAL и Shikimori обновляются локальным сервером. При отзыве доступа потребуется повторное подключение.
- Для публичного размещения понадобятся HTTPS, серверное хранилище токенов и redirect URI под домен. Локальную папку данных нельзя переносить на публичный сервер.

## Реализованные возможности

- Локальная библиотека на IndexedDB, каталог AniList, поиск, фильтры и карточки.
- Импорт MyAnimeList XML/XML.GZ и импорт списков из подключённых аккаунтов с предварительным просмотром.
- Резервные копии, snapshot restore, безопасное объединение записей и журнал операций.
- Обогащение метаданными AniList по точным внешним ID.
- Двусторонняя синхронизация статуса, прогресса и оценки с MAL, AniList и Shikimori.
- Синхронизация избранного поддерживается для AniList. MAL и Shikimori не получают это поле из локальной библиотеки.
- Для MAL и Shikimori учитывается их десятибалльная шкала оценок.
- Трёхстороннее сравнение по сохранённым provider baselines, разрешение конфликтов и восстановление незавершённых операций.
- Безопасные удаления с резервной копией, отдельным подтверждением и защитой от неполных/пустых ответов API.
- Обнаружение и резервное объединение дублей по точным внешним ID. Совпадения только по названию не объединяются.

## Ограничения интеграций

- MAL, AniList и Shikimori являются list providers: приложение читает и изменяет личные списки в пределах возможностей их API.
- Поля, которых нет в контракте конкретного сервиса, не синхронизируются. Избранное в текущей реализации поддерживается только AniList.
- AnimeGO, Anixart и YummyAnime пока не подключены. Для них планируется отдельная browser-extension интеграция для обнаружения контекста просмотра, а не синхронизация списка через OAuth API.
- Android, упакованное desktop-приложение и самостоятельный web backend относятся к отдельному этапу после завершения локального приложения.

## Проверка

~~~powershell
npm test
npm run typecheck
npm run build
~~~
