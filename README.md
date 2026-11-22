# mido-anime-sync

**Версия: v0.5**

Локальная аниме-библиотека с каталогом AniList, импортом и двусторонней синхронизацией MyAnimeList, AniList и Shikimori.

## Требования

- Node.js 22+
- npm 10+

## Установка и запуск (Windows)

1. Установи [Node.js 22 LTS или новее](https://nodejs.org/) через Windows Installer (.msi) для x64. Оставь включёнными установку npm и добавление Node.js в PATH.
2. Скачай репозиторий и распакуй его в постоянную папку, например `C:\\Projects\\mido-anime-sync`.
3. Дважды щёлкни `Setup-Windows.bat`. Он установит зависимости, создаст `.env.local` и ярлыки на рабочем столе.
4. Запускай приложение ярлыком `mido-anime-sync`. Серверы стартуют в скрытом режиме, а приложение откроется в браузере.
5. Для остановки используй ярлык `Остановить mido-anime-sync`.

После первоначальной настройки терминал для обычного запуска не нужен. Требуется Node.js 22+ и доступ к интернету для внешних каталогов и синхронизации. Не перемещай и не удаляй папку проекта после создания ярлыков: ярлыки ссылаются на неё.

Логи запуска находятся в `.local-data\\launcher.stdout.log` и `.local-data\\launcher.stderr.log`. API по умолчанию слушает только `127.0.0.1:3001`, интерфейс разработки открывается на `http://127.0.0.1:5173`.

Для ручного запуска из PowerShell доступны команды `npm run dev`, а для проверки: `npm run typecheck`, `npm test`, `npm run check:server`, `npm run check:extension` и `npm run build`.


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
- Browser extension Manifest V3 обнаруживает завершение HTML5-видео (90% длительности) на AnimeGO и YummyAnime, показывает событие в popup и передаёт его в локальное приложение после нажатия пользователя. Прогресс записывается в отдельный source entry только после подтверждения тайтла в приложении.
- Anixart: официальный сайт не предоставляет браузерный видеоплеер, а просмотр и списки доступны в Android-приложении. Расширение может отправить только ручное событие с веб-страницы; автоматическое отслеживание Android-приложения требует отдельного Android bridge.
- Tauri Windows и Capacitor Android уже имеют стартовую конфигурацию, но полноценная упаковка Node.js API, перенос IndexedDB и проверка нативных сборок остаются отдельными незавершёнными задачами.

## Проверка

~~~powershell
npm test
npm run typecheck
npm run check:server
npm run check:extension
npm run build
~~~


## Native application shells

The project now has a Tauri 2 Windows shell scaffold and a Capacitor 8 Android configuration. To install the native tooling and generate the Android Studio project, run:

```powershell
npm run setup:platforms
```

Then use:

```powershell
npm run tauri:dev
npm run tauri:build
npm run cap:sync
npm run cap:open:android
```

Windows builds require the Rust MSVC toolchain, Microsoft C++ Build Tools, and WebView2. Android builds require Android Studio and the Android SDK.

The native account platform layer uses Windows Credential Manager for Tauri sessions and Android Keystore-backed encrypted storage for Capacitor sessions. Provider sessions remain device-local and are not part of library synchronization.

**Current packaging limitation:** the existing local Node.js API server is started in Tauri development mode, but is not yet bundled as a production sidecar. Android also cannot run the Node server as-is. The native shell is therefore a development scaffold until those API responsibilities are moved into native commands or packaged as a managed sidecar. See [docs/platform-shells.md](docs/platform-shells.md).
