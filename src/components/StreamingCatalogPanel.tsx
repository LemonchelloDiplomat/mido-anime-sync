import { useEffect, useMemo, useState } from "react";
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
  anixart: "Каталог сайта, карточки, сезоны, серии и озвучки загружаются напрямую локальным сервером.",
};

async function searchProvider(provider: StreamingProviderId, query: string, signal: AbortSignal): Promise<StreamingSearchResult> {
  if (provider === "yummyanime") return searchYummyAnime(query, 1, signal);
  if (provider === "animego") return animeGo.search({ query, page: 1, signal });
  return anixArt.search({ query, page: 1, signal });
}

async function loadDetails(provider: StreamingProviderId, title: StreamingTitle, signal: AbortSignal): Promise<StreamingTitleDetails> {
  if (provider === "yummyanime") return getYummyAnimeTitle(title.externalId, signal);
  if (provider === "animego") return animeGo.getTitle(title.externalId, signal);
  return anixArt.getTitle(title.externalId, signal);
}

export function StreamingCatalogPanel({ query, onImport, onImportSnapshot }: Props) {
  const [provider, setProvider] = useState<StreamingProviderId>("yummyanime");
  const [results, setResults] = useState<StreamingTitle[]>([]);
  const [selected, setSelected] = useState<StreamingTitle | null>(null);
  const [details, setDetails] = useState<StreamingTitleDetails | null>(null);
  const [expandedEpisode, setExpandedEpisode] = useState<string | null>(null);
  const [episodeTracks, setEpisodeTracks] = useState<Record<string, StreamingVoice[]>>({});
  const [episodeTracksLoading, setEpisodeTracksLoading] = useState<Record<string, boolean>>({});
  const [activePlayer, setActivePlayer] = useState<{ name: string; url: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [accountStatus, setAccountStatus] = useState<YummyAnimeConnectionStatus | null>(null);
  const [accountLogin, setAccountLogin] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");

  const normalizedQuery = useMemo(() => query.trim(), [query]);

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
      .then((result) => setResults(result.items))
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
    if (!selected) {
      setDetails(null);
      return;
    }
    const controller = new AbortController();
    setDetailsLoading(true);
    setExpandedEpisode(null);
    setEpisodeTracks({});
    setEpisodeTracksLoading({});
    void loadDetails(provider, selected, controller.signal)
      .then(setDetails)
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить карточку.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailsLoading(false);
      });
    return () => controller.abort();
  }, [provider, selected]);

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
    try {
      const tracks = await animeGo.getEpisodeVoices(episodeId);
      setEpisodeTracks((current) => ({ ...current, [episodeKey]: tracks }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить озвучки AnimeGO.");
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
          <h2>Каталоги стриминговых сайтов</h2>
          <p>Поиск на AnimeGO, YummyAnime и AnixART отдельно от каталогов MAL, AniList и Shikimori.</p>
        </div>
        <select aria-label="Источник каталога" value={provider} onChange={(event) => setProvider(event.target.value as StreamingProviderId)}>
          <option value="yummyanime">YummyAnime</option>
          <option value="animego">AnimeGO</option>
          <option value="anixart">AnixART</option>
        </select>
      </div>
      <p className="streaming-provider-note">{providerNotes[provider]}</p>
      {provider === "yummyanime" && (
        <div className="streaming-account-panel">
          <div className="streaming-account-heading"><strong>Аккаунт YummyAnime</strong><span>{accountStatus?.connected ? "Подключён: " + accountStatus.username : accountStatus?.configured ? "Не подключён" : "Нужен X-Application token"}</span></div>
          {!accountStatus?.configured ? <p className="streaming-limitation">Создай личное приложение на yummyani.me/dev/applications и добавь его токен в YUMMY_APPLICATION_TOKEN в .env.local, затем перезапусти сервер.</p> : accountStatus.connected ? (
            <div className="streaming-account-actions"><button type="button" disabled={accountBusy} onClick={() => void importYummyAnimeAccount()}>{accountBusy ? "Загружаем..." : "Импортировать мои списки и историю"}</button><button type="button" className="secondary" disabled={accountBusy} onClick={() => void disconnectYummyAnime()}>Отключить</button></div>
          ) : (
            <form className="streaming-login-form" onSubmit={(event) => void connectYummyAnime(event)}><input required autoComplete="username" placeholder="Логин или e-mail" value={accountLogin} onChange={(event) => setAccountLogin(event.target.value)} /><input required type="password" autoComplete="current-password" placeholder="Пароль YummyAnime" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} /><button type="submit" disabled={accountBusy || !accountLogin.trim() || !accountPassword}>{accountBusy ? "Подключаем..." : "Подключить аккаунт"}</button></form>
          )}
          {accountMessage && <p className="streaming-account-message" role="status">{accountMessage}</p>}
        </div>
      )}
      {normalizedQuery.length < 2 ? (
        <p className="catalog-hint">Введи минимум 2 символа в поле поиска выше.</p>
      ) : loading ? (
        <p className="catalog-hint">Ищем на {providerLabels[provider]}...</p>
      ) : error ? (
        <p className="catalog-error" role="alert">{error}</p>
      ) : results.length === 0 ? (
        <p className="catalog-hint">На {providerLabels[provider]} ничего не найдено.</p>
      ) : (
        <div className="streaming-catalog-results">
          <div className="streaming-catalog-list">
            {results.map((item) => (
              <button type="button" className={selected?.externalId === item.externalId ? "streaming-result selected" : "streaming-result"} key={item.externalId} onClick={() => setSelected(item)}>
                {item.posterUrl ? <img src={item.posterUrl} alt="" loading="lazy" /> : <span className="streaming-poster-placeholder">✦</span>}
                <span><strong>{item.title}</strong>{item.year ? <small>{item.year}</small> : null}</span>
              </button>
            ))}
          </div>
          <div className="streaming-catalog-detail">
            {!selected ? (
              <p className="catalog-hint">Выбери тайтл, чтобы загрузить подробности.</p>
            ) : detailsLoading ? (
              <p className="catalog-hint">Загружаем карточку...</p>
            ) : details ? (
              <>
                <h3>{details.title}</h3>
                {details.description && <p>{details.description}</p>}
                <p className="streaming-detail-meta">{details.year || "Год не указан"}{provider !== "anixart" && details.episodeCount ? " · " + details.episodeCount + " эп." : provider === "anixart" && details.episodeCount ? " · " + details.episodeCount + " эп." : ""}</p>
                {details.seasons.length > 0 && <div className="streaming-season-list">
                  <strong>Серии</strong>
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
                            <strong>Варианты озвучки</strong>
                            {tracksLoading ? <p>Загружаем варианты озвучки...</p> : tracks.length ? <ul>{tracks.map((track) => <li key={track.externalId}>
                              <span className="streaming-voice-info"><strong>{track.name}</strong><small>{track.playerName || "Плеер не указан"} · ID {track.externalId}</small></span>
                              {track.playerUrl ? <button type="button" className="secondary streaming-play-button" onClick={() => setActivePlayer({ name: "Серия " + episode.number + " · " + track.name, url: track.playerUrl! })}>Смотреть</button> : provider === "anixart" ? <a href={details.url} target="_blank" rel="noreferrer">Открыть на AnixART ↗</a> : <small>Нет адреса плеера</small>}
                            </li>)}</ul> : <p>Для этой серии API не вернул список озвучек.</p>}
                            <p className="streaming-limitation">Плеер открывается во встроенном окне, если источник разрешает встраивание. Некоторые сайты могут блокировать воспроизведение.</p>
                          </div>}
                        </article>;
                      })}
                    </div>
                  </section>)}
                </div>}

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
          <header><strong>{activePlayer.name}</strong><button type="button" className="secondary" onClick={() => setActivePlayer(null)}>Закрыть</button></header>
          <iframe key={activePlayer.url} src={activePlayer.url} title={activePlayer.name} referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen />
          <p>Если встроенный просмотр не запускается, попробуй открыть сам плеер отдельно. Некоторые источники ограничивают воспроизведение внутри других сайтов.</p><a href={activePlayer.url} target="_blank" rel="noreferrer">Открыть плеер отдельно ↗</a>
        </section>
      </div>}
    </section>
  );
}
