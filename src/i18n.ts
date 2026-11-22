export type AppLocale = "ru" | "en" | "ja";

const STORAGE_KEY = "mido-anime-sync:locale";

const messages: Record<AppLocale, Record<string, string>> = {
  ru: {
    language: "Язык приложения", russian: "Русский", english: "English", japanese: "日本語",
    streamingTitle: "Каталоги стриминговых сайтов",
    streamingDescription: "Поиск на AnimeGO, YummyAnime и AnixART отдельно от каталогов MAL, AniList и Shikimori.",
    providerLabel: "Источник каталога", sortLabel: "Сортировка", sortSource: "По релевантности", sortTitle: "По названию", sortRating: "По рейтингу", sortYear: "По году", account: "Аккаунт YummyAnime",
    minQuery: "Введи минимум 2 символа в поле поиска выше.",
    chooseTitle: "Выбери тайтл, чтобы загрузить подробности.",
    loadingCard: "Загружаем карточку...", retry: "Повторить загрузку",
    openSite: "Открыть на сайте ↗", addLibrary: "Добавить в библиотеку",
    adding: "Добавляем...", yearUnknown: "Год не указан", episodes: "Серии",
    voices: "Варианты озвучки", watch: "Смотреть", close: "Закрыть",
    playerConnecting: "Подключаем плеер...", noPoster: "Постер недоступен",
    noResults: "На сервисе ничего не найдено.", searching: "Ищем на",
    noVoices: "Для этой серии варианты озвучки не указаны.",
    openOnProvider: "Открыть на сервисе ↗", loadingVoices: "Загружаем варианты озвучки...",
  },
  en: {
    language: "App language", russian: "Русский", english: "English", japanese: "日本語",
    streamingTitle: "Streaming catalogs",
    streamingDescription: "Search AnimeGO, YummyAnime and AnixART separately from MAL, AniList and Shikimori.",
    providerLabel: "Catalog source", sortLabel: "Sort by", sortSource: "Relevance", sortTitle: "Title (A–Z)", sortRating: "Rating (high to low)", sortYear: "Year (newest first)", account: "YummyAnime account",
    minQuery: "Enter at least 2 characters in the search field above.",
    chooseTitle: "Select a title to load its details.",
    loadingCard: "Loading title details...", retry: "Retry",
    openSite: "Open website ↗", addLibrary: "Add to library",
    adding: "Adding...", yearUnknown: "Year unknown", episodes: "Episodes",
    voices: "Audio options", watch: "Watch", close: "Close",
    playerConnecting: "Connecting player...", noPoster: "Poster unavailable",
    noResults: "No titles found on this service.", searching: "Searching",
    noVoices: "No audio options are listed for this episode.",
    openOnProvider: "Open on provider ↗", loadingVoices: "Loading audio options...",
  },
  ja: {
    language: "アプリの言語", russian: "Русский", english: "English", japanese: "日本語",
    streamingTitle: "配信サイトのカタログ",
    streamingDescription: "MAL、AniList、Shikimoriとは別にAnimeGO、YummyAnime、AnixARTを検索します。",
    providerLabel: "カタログの提供元", sortLabel: "並べ替え", sortSource: "関連度順", sortTitle: "タイトル順", sortRating: "評価の高い順", sortYear: "新しい年順", account: "YummyAnimeアカウント",
    minQuery: "上の検索欄に2文字以上入力してください。",
    chooseTitle: "作品を選択して詳細を読み込みます。",
    loadingCard: "作品情報を読み込み中...", retry: "再試行",
    openSite: "サイトを開く ↗", addLibrary: "ライブラリに追加",
    adding: "追加中...", yearUnknown: "公開年不明", episodes: "エピソード",
    voices: "音声オプション", watch: "再生", close: "閉じる",
    playerConnecting: "プレーヤーに接続中...", noPoster: "ポスターなし",
    noResults: "このサービスでは作品が見つかりませんでした。", searching: "検索中",
    noVoices: "このエピソードの音声オプションはありません。",
    openOnProvider: "配信サイトで開く ↗", loadingVoices: "音声オプションを読み込み中...",
  },
};

export function getAppLocale(): AppLocale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "ru" || saved === "en" || saved === "ja") return saved;
    const browserLanguage = navigator.language.toLowerCase();
    if (browserLanguage.startsWith("ja")) return "ja";
    if (browserLanguage.startsWith("en")) return "en";
  } catch {
    // Storage may be unavailable in private or restricted browsing contexts.
  }
  return "ru";
}

export function saveAppLocale(locale: AppLocale): void {
  try { localStorage.setItem(STORAGE_KEY, locale); } catch {
    // The current session still uses the selected locale when storage is blocked.
  }
}

export function t(locale: AppLocale, key: string): string {
  return messages[locale][key] ?? messages.ru[key] ?? key;
}

/** Preserve native scripts and punctuation when preparing provider search input. */
export function normalizeCatalogQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}
