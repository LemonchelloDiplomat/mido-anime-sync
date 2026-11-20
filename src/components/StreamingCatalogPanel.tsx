import { useEffect, useMemo, useState } from "react";
import { normalizeCatalogQuery, t, type AppLocale } from "../i18n.js";
import { searchAniListAnimeBatch } from "../services/anilist.js";
import { applyFallbackMetadata } from "../services/streaming-metadata.js";
import type { FormEvent } from "react";
import type { AnimeIdentity, AnimeSnapshotV4 } from "../core/types.js";
import { parseYummyAccountSnapshot } from "../services/yummyanime.js";
import { fetchYummyAnimeHistory, fetchYummyAnimeLists, getYummyAnimeStatus, loginYummyAnime, logoutYummyAnime, type YummyAnimeConnectionStatus } from "../services/yummyanime-api.js";
import { AnimeGoCatalogProvider } from "../services/animego.js";
import { AnixArtCatalogProvider } from "../services/anixart.js";
import { getYummyAnimeTitle, searchYummyAnime } from "../services/yummyanime-api.js";
import type {
  StreamingProviderId,
  StreamingSearchResult,
  StreamingTitle,
  StreamingTitleDetails,
  StreamingVoice,
} from "../services/streaming-provider.js";

type Props = {
  query: string;
  onImport: (anime: AnimeIdentity) => Promise<void>;
  onImportSnapshot: (snapshot: AnimeSnapshotV4) => Promise<void>;
  locale?: AppLocale;
};

const animeGo = new AnimeGoCatalogProvider();
const anixArt = new AnixArtCatalogProvider();

const providerLabels: Record<StreamingProviderId, string> = {
  yummyanime: "YummyAnime",
  animego: "AnimeGO",
  anixart: "AnixART",
};

const providerNotes: Record<StreamingProviderId, string> = {
  yummyanime: "Каталог, карточки, серии, озвучки и API аккаунта. Для входа нужен личный X-Application token.",
  animego: "Публичный каталог, карточки, серии и озвучки. Прогресс передаёт браузерное расширение.",
  anixart: "Каталог и озвучки загружаются сервером AnixART; видео воспроизводится во встроенном плеере через локальный потоковый прокси.",
};

async function searchProvider(provider: StreamingProviderId, query: string, signal: AbortSignal): Promise<StreamingSearchResult> {
  // A provider that stalls must never leave the catalog in its permanent loading state.
  const timeout = AbortSignal.timeout(25_000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  try {
    if (provider === "yummyanime") return await searchYummyAnime(query, 1, requestSignal);
    if (provider === "animego") return await animeGo.search({ query, page: 1, signal: requestSignal });
    return await anixArt.search({ query, page: 1, signal: requestSignal });
  } catch (error) {
    if (timeout.aborted && !signal.aborted) {
      throw new Error(providerLabels[provider] + ": поиск не ответил за 25 секунд. Проверь соединение с сайтом и попробуй ещё раз.");
    }
    throw error;
  }
}

async function loadDetails(provider: StreamingProviderId, title: StreamingTitle, signal: AbortSignal): Promise<StreamingTitleDetails> {
  if (provider === "yummyanime") return getYummyAnimeTitle(title.externalId, signal);
  if (provider === "animego") return animeGo.getTitle(title.externalId, signal);
  return anixArt.getTitle(title.externalId, signal);
}

export function StreamingCatalogPanel({ query, onImport, onImportSnapshot, locale = "ru" }: Props) {
  const [provider, setProvider] = useState<StreamingProviderId>("yummyanime");
  const [results, setResults] = useState<StreamingTitle[]>([]);
  const [selected, setSelected] = useState<StreamingTitle | null>(null);
  const [details, setDetails] = useState<StreamingTitleDetails | null>(null);
  const [expandedEpisode, setExpandedEpisode] = useState<string | null>(null);
  const [episodeTracks, setEpisodeTracks] = useState<Record<string, StreamingVoice[]>>({});
  const [episodeTracksLoading, setEpisodeTracksLoading] = useState<Record<string, boolean>>({});
  const [episodeTracksError, setEpisodeTracksError] = useState<Record<string, string>>({});
  const [activePlayer, setActivePlayer] = useState<{ name: string; url: string; kind: "embed" | "video" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [detailsAttempt, setDetailsAttempt] = useState(0);
  const [failedPosters, setFailedPosters] = useState<Record<string, "provider" | "fallback">>({});
  const [playerError, setPlayerError] = useState("");
  const [playerLoaded, setPlayerLoaded] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [accountStatus, setAccountStatus] = useState<YummyAnimeConnectionStatus | null>(null);
  const [accountLogin, setAccountLogin] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");
  const [catalogSort, setCatalogSort] = useState<"year-desc" | "year-asc" | "score" | "title">("year-desc");

  const normalizedQuery = useMemo(() => normalizeCatalogQuery(query), [query]);
  const sortedResults = useMemo(() => [...results].sort((a, b) => {
    if (catalogSort === "score") {
      if (a.averageScore == null && b.averageScore == null) return a.title.localeCompare(b.title);
      if (a.averageScore == null) return 1;
      if (b.averageScore == null) return -1;
      return b.averageScore - a.averageScore;
    }
    if (catalogSort === "title") return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    if (a.year == null && b.year == null) return a.title.localeCompare(b.title);
    if (a.year == null) return 1;
    if (b.year == null) return -1;
    return catalogSort === "year-asc" ? a.year - b.year : b.year - a.year;
  }), [results, catalogSort]);

  useEffect(() => {
    if (!activePlayer || playerLoaded || playerError) return;
    const timer = window.setTimeout(() => {
      setPlayerError("Плеер не ответил за 15 секунд. Открой тайтл на сайте сервиса или попробуй другой вариант озвучки.");
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [activePlayer, playerLoaded, playerError]);

  useEffect(() => {
    let active = true;
    void getYummyAnimeStatus().then((status) => { if (active) setAccountStatus(status); }).catch(() => { if (active) setAccountStatus(null); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (normalizedQuery.length < 2) {
      setResults([]);
      setSelected(null);
      setDetails(null);
      setExpandedEpisode(null);
      setError("");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSelected(null);
    setDetails(null);
    setExpandedEpisode(null);
    void searchProvider(provider, normalizedQuery, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        // AnimeGO uses unstable CDN poster URLs, so always look for a verified
        // AniList cover. Other providers only need fallback when metadata is absent.
        // AnimeGO and AnixART can return poster URLs that exist syntactically but
        // fail when loaded. Resolve a small set of title-specific AniList candidates
        // so the UI can switch to a verified cover after an image error. Matching
        // remains exact (including aliases) and ambiguous matches are rejected.
        const needsFallback = provider !== "yummyanime";
        if (!needsFallback) {
          setResults(result.items);
          return;
        }
        try {
          const fallbackQueries = [...new Set([
            normalizedQuery,
            ...result.items.slice(0, 8).flatMap((item) => [item.title, ...(item.alternativeTitles || []).slice(0, 1)]),
          ].map((value) => value.trim()).filter((value) => value.length >= 2))].slice(0, 9);
          const metadata = await searchAniListAnimeBatch(fallbackQueries, controller.signal);
          if (controller.signal.aborted) return;
          setResults(result.items.map((item) => applyFallbackMetadata(item, metadata, {
            preferPoster: provider === "animego",
          })));
        } catch (reason) {
          if (!controller.signal.aborted) {
            console.warn("Не удалось загрузить резервные метаданные AniList для каталога:", reason);
            setResults(result.items);
          }
        }
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Не удалось выполнить поиск.");
        setResults([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [normalizedQuery, provider]);

  useEffect(() => {
    if (!selected || selected.provider !== provider) {
      setDetails(null);
      setDetailsLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(20_000);
    const requestSignal = AbortSignal.any([controller.signal, timeout]);
    setDetails(null);
    setDetailsError("");
    setDetailsLoading(true);
    setExpandedEpisode(null);
    setEpisodeTracks({});
    setEpisodeTracksLoading({});
    void loadDetails(provider, selected, requestSignal)
      .then((result) => {
        if (!controller.signal.aborted) setDetails(result);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setDetailsError(timeout.aborted
          ? providerLabels[provider] + ": карточка не ответила за 20 секунд. Можно повторить запрос или открыть тайтл на сайте."
          : reason instanceof Error ? reason.message : "Не удалось загрузить карточку.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailsLoading(false);
      });
    return () => controller.abort();
  }, [provider, selected, detailsAttempt]);

  async function connectYummyAnime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accountBusy) return;
    setAccountBusy(true);
    setAccountMessage("");
    try {
      await loginYummyAnime(accountLogin, accountPassword);
      setAccountPassword("");
      setAccountStatus(await getYummyAnimeStatus());
      setAccountMessage("Аккаунт YummyAnime подключён.");
    } catch (reason) {
      const captchaRequired = Boolean(reason && typeof reason === "object" && "captchaRequired" in reason && reason.captchaRequired);
      setAccountMessage(captchaRequired ? "YummyAnime запросил hCaptcha (HTTP 420). В текущем интерфейсе нет встроенного виджета проверки, поэтому подключение этого аккаунта пока приостановлено. Защиту не обходим." : reason instanceof Error ? reason.message : "Не удалось подключить аккаунт.");
    } finally { setAccountBusy(false); }
  }

  async function disconnectYummyAnime() {
    setAccountBusy(true);
    setAccountMessage("");
    try { await logoutYummyAnime(); setAccountStatus(await getYummyAnimeStatus()); setAccountMessage("Аккаунт отключён."); }
    catch (reason) { setAccountMessage(reason instanceof Error ? reason.message : "Не удалось отключить аккаунт."); }
    finally { setAccountBusy(false); }
  }

  async function importYummyAnimeAccount() {
    if (accountBusy) return;
    setAccountBusy(true);
    setAccountMessage("");
    try {
      const lists = await fetchYummyAnimeLists();
      const listSnapshot = parseYummyAccountSnapshot({ response: lists.entries });
      const historySnapshot = await fetchYummyAnimeHistory(500, 0);
      const animeById = new Map(listSnapshot.anime.map((anime) => [anime.id, anime]));
      historySnapshot.anime.forEach((anime) => { if (!animeById.has(anime.id)) animeById.set(anime.id, anime); });
      const entriesById = new Map(listSnapshot.entries.map((entry) => [entry.animeId, entry]));
      historySnapshot.entries.forEach((entry) => {
        const previous = entriesById.get(entry.animeId);
        if (!previous) entriesById.set(entry.animeId, entry);
        else entriesById.set(entry.animeId, {
          ...previous,
          progress: Math.max(previous.progress, entry.progress),
          updatedAt: Date.parse(entry.updatedAt) > Date.parse(previous.updatedAt) ? entry.updatedAt : previous.updatedAt,
          sourceMetadata: { ...previous.sourceMetadata, ...entry.sourceMetadata },
        });
      });
      const entries = [...entriesById.values()];
      const snapshot: AnimeSnapshotV4 = {
        ...listSnapshot,
        exportedAt: new Date().toISOString(),
        anime: [...animeById.values()],
        entries,
        sourceEntries: entries,
      };
      await onImportSnapshot(snapshot);
      setAccountMessage("Импортировано записей YummyAnime: " + entries.length + ".");
    } catch (reason) {
      setAccountMessage(reason instanceof Error ? reason.message : "Не удалось импортировать данные аккаунта.");
    } finally { setAccountBusy(false); }
  }

  async function toggleEpisode(episodeKey: string, episodeId: string, hasPreloadedTracks = false) {
    if (expandedEpisode === episodeKey) {
      setExpandedEpisode(null);
      return;
    }
    setExpandedEpisode(episodeKey);
    if (provider !== "animego" || hasPreloadedTracks || episodeTracks[episodeKey] || episodeTracksLoading[episodeKey]) return;
    setEpisodeTracksLoading((current) => ({ ...current, [episodeKey]: true }));
    setEpisodeTracksError((current) => ({ ...current, [episodeKey]: "" }));
    const timeout = AbortSignal.timeout(12000);
    try {
      const tracks = await animeGo.getEpisodeVoices(episodeId, timeout);
      setEpisodeTracks((current) => ({ ...current, [episodeKey]: tracks }));
    } catch (reason) {
      setEpisodeTracksError((current) => ({
        ...current,
        [episodeKey]: timeout.aborted
          ? "AnimeGO не вернул озвучки за 12 секунд. Попробуй ещё раз или открой тайтл на сайте."
          : reason instanceof Error ? reason.message : "Не удалось загрузить озвучки AnimeGO.",
      }));
    } finally {
      setEpisodeTracksLoading((current) => ({ ...current, [episodeKey]: false }));
    }
  }

  async function importSelected() {
    if (!details?.identity || importing) return;
    setImporting(true);
    setError("");
    try {
      await onImport(details.identity);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось добавить аниме в библиотеку.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="streaming-catalog-panel">
      <div className="streaming-catalog-heading">
        <div>
          <h2>{t(locale, "streamingTitle")}</h2>
          <p>{t(locale, "streamingDescription")}</p>
        </div>
        <select aria-label={t(locale, "providerLabel")} value={provider} onChange={(event) => {
          const nextProvider = event.target.value as StreamingProviderId;
          setProvider(nextProvider);
          setResults([]);
          setSelected(null);
          setDetails(null);
          setExpandedEpisode(null);
          setEpisodeTracks({});
          setEpisodeTracksLoading({});
          setError("");
          setDetailsError("");
          setFailedPosters({});
        }}>
          <option value="yummyanime">YummyAnime</option>
          <option value="animego">AnimeGO</option>
          <option value="anixart">AnixART</option>
        </select>
      </div>
      <div className="streaming-catalog-toolbar">
        <label>Сортировка
          <select value={catalogSort} onChange={(event) => setCatalogSort(event.target.value as typeof catalogSort)}>
            <option value="year-desc">Сначала новые</option>
            <option value="year-asc">Сначала старые</option>
            <option value="score">По рейтингу</option>
            <option value="title">По названию</option>
          </select>
        </label>
      </div>
      <p className="streaming-provider-note">{providerNotes[provider]}</p>
      {provider === "yummyanime" && (
        <div className="streaming-account-panel">
          <div className="streaming-account-heading"><strong>{t(locale, "account")}</strong><span>{accountStatus?.connected ? "Подключён: " + accountStatus.username : accountStatus?.configured ? "Не подключён" : "Нужен X-Application token"}</span></div>
          {!accountStatus?.configured ? <p className="streaming-limitation">Создай личное приложение на yummyani.me/dev/applications и добавь его токен в YUMMY_APPLICATION_TOKEN в .env.local, затем перезапусти сервер.</p> : accountStatus.connected ? (
            <div className="streaming-account-actions"><button type="button" disabled={accountBusy} onClick={() => void importYummyAnimeAccount()}>{accountBusy ? "Загружаем..." : "Импортировать мои списки и историю"}</button><button type="button" className="secondary" disabled={accountBusy} onClick={() => void disconnectYummyAnime()}>Отключить</button></div>
          ) : (
            <form className="streaming-login-form" onSubmit={(event) => void connectYummyAnime(event)}><input required autoComplete="username" placeholder="Логин или e-mail" value={accountLogin} onChange={(event) => setAccountLogin(event.target.value)} /><input required type="password" autoComplete="current-password" placeholder="Пароль YummyAnime" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} /><button type="submit" disabled={accountBusy || !accountLogin.trim() || !accountPassword}>{accountBusy ? "Подключаем..." : "Подключить аккаунт"}</button></form>
          )}
          {accountMessage && <p className="streaming-account-message" role="status">{accountMessage}</p>}
        </div>
      )}
      {normalizedQuery.length < 2 ? (
        <p className="catalog-hint">{t(locale, "minQuery")}</p>
      ) : loading ? (
        <p className="catalog-hint">{t(locale, "searching")} {providerLabels[provider]}...</p>
      ) : error ? (
        <p className="catalog-error" role="alert">{error}</p>
      ) : results.length === 0 ? (
        <p className="catalog-hint">{t(locale, "noResults")}</p>
      ) : (
        <div className="streaming-catalog-results">
          <div className="streaming-catalog-list">
            {sortedResults.map((item) => {
              const posterKey = provider + ":" + item.externalId;
              const posterFailure = failedPosters[posterKey];
              const usingFallbackPoster = posterFailure === "provider";
              const displayPoster = usingFallbackPoster ? item.fallbackPosterUrl : item.posterUrl;
              return (
              <button type="button" className={selected?.externalId === item.externalId ? "streaming-result selected" : "streaming-result"} key={item.externalId} onClick={() => setSelected(item)}>
                <span className="streaming-result-poster">
                  {displayPoster && posterFailure !== "fallback"
                    ? <img src={provider === "animego" && !usingFallbackPoster && item.posterSource !== "AniList" ? "/api/animego/poster?url=" + encodeURIComponent(displayPoster) : displayPoster} alt="" loading="lazy" onError={() => setFailedPosters((current) => ({ ...current, [posterKey]: current[posterKey] === "provider" ? "fallback" : "provider" }))} />
                    : <span className="streaming-poster-placeholder" title={t(locale, "noPoster")}>✦</span>}
                  {item.averageScore != null && <b className={`streaming-score ${item.averageScore >= 8 ? "excellent" : item.averageScore >= 7 ? "good" : item.averageScore >= 5 ? "average" : "poor"}`} title={`Оценка: ${item.scoreSource || providerLabels[provider]}`}>{item.averageScore.toFixed(1)}</b>}
                </span>
                <span><strong>{item.title}</strong>{item.year ? <small>{item.year}</small> : null}{item.averageScore != null ? <small>★ {item.averageScore.toFixed(1)} · {item.scoreSource || providerLabels[provider]}</small> : null}</span>
              </button>
              );
            })}
          </div>
          <div className="streaming-catalog-detail">
            {!selected ? (
              <p className="catalog-hint">{t(locale, "chooseTitle")}</p>
            ) : detailsLoading ? (
              <p className="catalog-hint">{t(locale, "loadingCard")}</p>
            ) : detailsError ? (
              <div className="streaming-detail-error" role="alert">
                <p className="catalog-error">{detailsError}</p>
                <div className="streaming-detail-actions">
                  <button type="button" className="secondary" onClick={() => setDetailsAttempt((value) => value + 1)}>{t(locale, "retry")}</button>
                  {selected && <a href={selected.url} target="_blank" rel="noreferrer">{t(locale, "openSite")}</a>}
                </div>
              </div>
            ) : details ? (
              <>
                <h3>{details.title}</h3>
                {details.description && <p>{details.description}</p>}
                <p className="streaming-detail-meta">{details.year || t(locale, "yearUnknown")}{provider !== "anixart" && details.episodeCount ? " · " + details.episodeCount + " эп." : provider === "anixart" && details.episodeCount ? " · " + details.episodeCount + " эп." : ""}</p>
                {details.seasons.length > 0 ? <div className="streaming-season-list">
                  <strong>{t(locale, "episodes")}</strong>
                  {details.seasons.map((season) => <section className="streaming-season" key={season.number}>
                    <h4>{season.title || "Сезон " + season.number}</h4>
                    <div className="streaming-episode-list">
                      {season.episodes.map((episode) => {
                        const episodeKey = provider + ":" + selected.externalId + ":" + season.number + ":" + episode.number;
                        const isExpanded = expandedEpisode === episodeKey;
                        const tracks = episodeTracks[episodeKey] || episode.voiceTracks || [];
                        const tracksLoading = provider === "animego" && Boolean(episodeTracksLoading[episodeKey]);
                        return <article className={"streaming-episode" + (isExpanded ? " expanded" : "")} key={episodeKey}>
                          <button type="button" className="streaming-episode-toggle" aria-expanded={isExpanded} onClick={() => void toggleEpisode(episodeKey, episode.externalId, Boolean(episode.voiceTracks?.length))}>
                            <span><strong>Серия {episode.number}</strong>{episode.title ? <small>{episode.title}</small> : null}</span>
                            <span className="streaming-episode-summary">{tracks.length ? tracks.length + " озвуч." : "Озвучки не указаны"} <span aria-hidden="true">{isExpanded ? "−" : "+"}</span></span>
                          </button>
                          {isExpanded && <div className="streaming-episode-voices">
                            <strong>{t(locale, "voices")}</strong>
                            {tracksLoading ? <p>{t(locale, "loadingVoices")}</p> : episodeTracksError[episodeKey] ? <p className="catalog-error" role="alert">{episodeTracksError[episodeKey]}</p> : tracks.length ? <ul>{tracks.map((track) => <li key={track.externalId}>
                              <span className="streaming-voice-info"><strong>{track.name}</strong><small>{provider === "anixart" ? (track.playerName || "Тип озвучки не указан") : (track.playerName || "Плеер не указан") + " · ID " + track.externalId}</small></span>
                              {track.playerUrl ? <button type="button" className="secondary streaming-play-button" onClick={() => { setPlayerError(""); setPlayerLoaded(false); setActivePlayer({ name: "Серия " + episode.number + " · " + track.name, url: track.playerUrl!, kind: provider === "anixart" ? "video" : "embed" }); }}>{t(locale, "watch")}</button> : <a href={details.url} target="_blank" rel="noreferrer">{t(locale, "openOnProvider")}</a>}
                            </li>)}</ul> : <p>{t(locale, "noVoices")}</p>}
                            <p className="streaming-limitation">Плеер открывается во встроенном окне, если источник разрешает встраивание. Некоторые сайты могут блокировать воспроизведение.</p>
                          </div>}
                        </article>;
                      })}
                    </div>
                  </section>)}
                </div> : <p className="catalog-hint">{t(locale, "noEpisodes")}</p>}

                <div className="streaming-detail-actions">
                  <a href={details.url} target="_blank" rel="noreferrer">Открыть на сайте ↗</a>
                  <button type="button" disabled={!details.identity || importing} onClick={() => void importSelected()}>{importing ? "Добавляем..." : "Добавить в библиотеку"}</button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
      {activePlayer && <div className="streaming-player-backdrop" role="presentation" onClick={() => setActivePlayer(null)}>
        <section className="streaming-player-dialog" role="dialog" aria-modal="true" aria-label={activePlayer.name} onClick={(event) => event.stopPropagation()}>
          <header><strong>{activePlayer.name}</strong><button type="button" className="secondary" onClick={() => setActivePlayer(null)}>{t(locale, "close")}</button></header>
          {activePlayer.kind === "video" ? (
            <video key={activePlayer.url} src={activePlayer.url} controls autoPlay playsInline preload="metadata"
              onLoadedMetadata={() => setPlayerLoaded(true)}
              onError={() => setPlayerError("Не удалось загрузить видео. Источник недоступен или не поддерживает MP4.")} />
          ) : (
            <iframe key={activePlayer.url} src={activePlayer.url} title={activePlayer.name} referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen
              onLoad={() => setPlayerLoaded(true)}
              onError={() => setPlayerError("Встроенный плеер не загрузился. Попробуй открыть его отдельно.")} />
          )}
          {playerError && <p className="catalog-error" role="alert">{playerError}</p>}
          {!playerLoaded && !playerError && <p role="status">{t(locale, "playerConnecting")}</p>}
          <p>{activePlayer.kind === "video" ? "Видео передаётся локальным сервером. Если источник не отвечает, открой тайтл на сайте сервиса." : "Некоторые сайты запрещают встраивание плеера. В таком случае открой его отдельно."}</p>
          {activePlayer.kind === "embed" && <a href={activePlayer.url} target="_blank" rel="noreferrer">Открыть плеер отдельно ↗</a>}
        </section>
      </div>}
    </section>
  );
}
