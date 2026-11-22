import { useEffect, useMemo, useRef, useState } from "react";
import { getAppLocale, saveAppLocale, type AppLocale, t } from "./i18n.js";
import type { ChangeEvent, FormEvent } from "react";

import type {
  AnimeIdentity,
  AnimeAgeRating,
  AnimeFormat,
  AnimeReleaseStatus,
  AnimeListEntry,
  AnimeSnapshot,
  AnimeSnapshotV4,
  AnimeStatus,
  SyncOperation,
  SyncSession,
  SyncDeletionIntent,
  SyncProvider,
} from "./core/types.js";

import { BrowserAnimeRepository } from "./storage/browser-repository.js";
import { resolveLibraryDatabaseName } from "./storage/database-name.js";
import { validateSnapshot } from "./storage/snapshot-validation.js";
import { DEFAULT_LIBRARY_FILTERS, filterLibrary, type LibraryFilters } from "./core/library-filter.js";
import { aniListMetadataProvider, fetchAniListAnimeDetails, getAniListMetadataCandidates, searchAniListAnime, type AniListAnimeDetails } from "./services/anilist.js";
import { parseMyAnimeListXml, readMyAnimeListExport } from "./services/myanimelist-import.js";
import { connectIntegration, disconnectIntegration, getIntegrationStatus, fetchAccountList, updateAccountEntry, deleteAccountEntry, type IntegrationStatus } from "./services/integrations-api.js";
import { parseMyAnimeListApiList } from "./services/myanimelist-account.js";
import { parseAniListAccountList, type AniListScoreFormat } from "./services/anilist-account.js";
import { parseShikimoriAccountList } from "./services/shikimori-account.js";
import { StreamingCatalogPanel } from "./components/StreamingCatalogPanel.js";
import { StreamingTrackerPanel } from "./components/StreamingTrackerPanel.js";
import { reconcileStreamingAccountSnapshot } from "./services/streaming-account-import.js";
import { normalizeAnimeGoAccountList, type AnimeGoAccountListPayload } from "./services/animego-account-import.js";
import { parseAnixartBookmarkExport } from "./services/anixart-export-import.js";
import { canAdvanceSyncBaseline, createBidirectionalSyncPlan } from "./core/bidirectional-sync.js";
import { suggestTrackerMatches, type TrackerMatchSuggestion } from "./services/streaming-tracker-sync.js";
import { detectRemoteDeletions } from "./core/safe-deletions.js";
import { executeRemoteDeletions, resolvePendingRemoteDeletionIntents } from "./core/remote-deletion.js";
import { reconcileUnfinishedSyncOperations } from "./core/sync-recovery.js";
import { mergeSharedMetadataIntoProviderMetadata } from "./core/shared-entry-metadata.js";
import { reconcileInterruptedSyncSessions } from "./core/sync-session-recovery.js";
import { findExactIdentityDuplicatePairs } from "./core/identity-reconciliation.js";
import { getProviderLabel, getProviderServiceId } from "./core/provider-capabilities.js";
import { createWatchSourceEntry, findExactAnimeTitleMatches, validateWatchEvent, type WatchEvent } from "./core/watch-events.js";

import {
  createImportPreview,
  type ImportPreview,
} from "./core/import-preview.js";
import {
  createRestorePreview,
  type RestorePreview,
} from "./core/restore-preview.js";

type LibraryItem = {
  anime: AnimeIdentity;
  entry: AnimeListEntry | undefined;
};

type MetadataEnrichmentProgress = {
  provider: string;
  completed: number;
  total: number;
  matched: number;
  missing: number;
};

type ImportIdentityDiagnostics = {
  provider: SyncProvider;
  total: number;
  withMyAnimeListId: number;
  withoutMyAnimeListId: number;
  apiReportedWithMyAnimeListId: number | null;
  matchedInLibrary: number;
  withMyAnimeListIdNotInLibrary: number;
  sampleMissingAnimeIds: number[];
  sampleUnmatchedTitles: string[];
};

type AnimeForm = {
  title: string;
  year: string;
  format: AnimeFormat | "";
  genres: string;
  ageRating: AnimeAgeRating | "";
  posterUrl: string;
  averageScore: string;
  startDate: string;
  releaseStatus: AnimeReleaseStatus | "";
  subtitle: string;
  episodes: string;
  progress: string;
  status: AnimeStatus;
  score: string;
  favorite: boolean;
};

const emptyForm: AnimeForm = {
  title: "",
  year: "",
  format: "",
  genres: "",
  ageRating: "",
  posterUrl: "",
  averageScore: "",
  startDate: "",
  releaseStatus: "",
  subtitle: "",
  episodes: "",
  progress: "0",
  status: "PLANNING",
  score: "",
  favorite: false,
};

const statusLabels: Record<AnimeStatus, string> = {
  PLANNING: "В планах",
  WATCHING: "Смотрю",
  COMPLETED: "Просмотрено",
  ON_HOLD: "Отложено",
  DROPPED: "Брошено",
  REWATCHING: "Пересматриваю",
};

function AnimeCover({ url, score }: { url?: string | null; score?: number | null }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  return (
    <div className="anime-cover purple">
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <>
          <span>✦</span>
          <small>ANIME</small>
        </>
      )}
      {score != null && (
        <span className={`poster-score ${score >= 8 ? "excellent" : score >= 7 ? "good" : score >= 5 ? "average" : "poor"}`}>
          {score.toFixed(1)}
        </span>
      )}
    </div>
  );
}

function App() {
  const [repository, setRepository] = useState<BrowserAnimeRepository | null>(
    null,
  );

  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [pendingWatchEvent, setPendingWatchEvent] = useState<WatchEvent | null>(null);
  const [pendingAnimeGoImportId, setPendingAnimeGoImportId] = useState("");
  const requestedAnimeGoImports = useRef(new Set<string>());
  const [pendingWatchEventId, setPendingWatchEventId] = useState("");
  const [watchEventTargetId, setWatchEventTargetId] = useState("");
  const [watchEventSaving, setWatchEventSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_LIBRARY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchPageOpen, setSearchPageOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [catalogResults, setCatalogResults] = useState<AnimeIdentity[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [hideAnimeInMyLists, setHideAnimeInMyLists] = useState(false);
  const [addingCatalogId, setAddingCatalogId] = useState<string | null>(null);
  const [catalogActionMessage, setCatalogActionMessage] = useState("");
  const [selectedAnime, setSelectedAnime] = useState<AnimeIdentity | null>(null);
  const [animeDetails, setAnimeDetails] = useState<AniListAnimeDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AnimeForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [importSnapshot, setImportSnapshot] = useState<AnimeSnapshot | null>(
    null,
  );

  const [importAnalysis, setImportAnalysis] = useState<ImportPreview | null>(
    null,
  );
  const [importSuggestions, setImportSuggestions] = useState<Record<string, TrackerMatchSuggestion[]>>({});
  const [importManualMappings, setImportManualMappings] = useState<Record<string, string>>({});

  const [importFormat, setImportFormat] = useState("");
  const [importIdentityDiagnostics, setImportIdentityDiagnostics] = useState<ImportIdentityDiagnostics | null>(null);

  const [importing, setImporting] = useState(false);
  const [restoreBackup, setRestoreBackup] = useState<AnimeSnapshotV4 | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreFormat, setRestoreFormat] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [deletingLibrary, setDeletingLibrary] = useState(false);
  const [reconcilingDuplicates, setReconcilingDuplicates] = useState(false);
  const restoreInProgressRef = useRef(false);
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);
  const syncInProgressRef = useRef(false);
  const [metadataEnriching, setMetadataEnriching] = useState(false);
  const [metadataProgress, setMetadataProgress] = useState<MetadataEnrichmentProgress | null>(null);
  const [metadataEnrichmentError, setMetadataEnrichmentError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appLocale, setAppLocale] = useState<AppLocale>(() => getAppLocale());
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [integrationStatusLoading, setIntegrationStatusLoading] = useState(false);
  const [integrationStatusError, setIntegrationStatusError] = useState("");
  const [accountSyncing, setAccountSyncing] = useState<SyncProvider | null>(null);
  const [syncConflictDialog, setSyncConflictDialog] = useState<{
    title: string;
    fields: string;
    resolve: (choice: "l" | "r" | "s") => void;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOperations, setHistoryOperations] = useState<SyncOperation[]>([]);
  const [historySessionRecords, setHistorySessionRecords] = useState<SyncSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyProviderFilter, setHistoryProviderFilter] = useState<"all" | SyncProvider>("all");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<"all" | SyncOperation["status"]>("all");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const importId = params.get("animegoImportId") || "";
    if (/^[0-9a-f-]{36}$/i.test(importId)) setPendingAnimeGoImportId(importId);
  }, []);

  useEffect(() => {
    if (!pendingAnimeGoImportId || !repository || loading) return;
    if (requestedAnimeGoImports.current.has(pendingAnimeGoImportId)) return;
    requestedAnimeGoImports.current.add(pendingAnimeGoImportId);

    const importId = pendingAnimeGoImportId;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.source !== "mido-anime-extension" ||
          data?.type !== "ANIMEGO_IMPORT_RESULT" || data.importId !== importId) return;
      if (!data.result?.ok || !data.result.payload) {
        setError(data.result?.error || "Не удалось получить список AnimeGO из расширения.");
        return;
      }
      void importAnimeGoAccountList(data.result.payload as AnimeGoAccountListPayload)
        .then(() => {
          window.postMessage({ source: "mido-anime-app", type: "ACK_ANIMEGO_IMPORT", importId }, window.location.origin);
          const params = new URLSearchParams(window.location.search);
          params.delete("animegoImportId");
          const query = params.toString();
          window.history.replaceState({}, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
          setPendingAnimeGoImportId("");
        })
        .catch((error: unknown) => {
          setError(error instanceof Error ? error.message : "Не удалось импортировать список AnimeGO.");
        });
    };
    window.addEventListener("message", handleMessage);
    window.postMessage({ source: "mido-anime-app", type: "REQUEST_ANIMEGO_IMPORT", importId }, window.location.origin);
    return () => window.removeEventListener("message", handleMessage);
  }, [pendingAnimeGoImportId, repository, loading]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rawEvent = params.get("watchEvent");
    if (!rawEvent) return;
    try {
      const parsedEvent = JSON.parse(rawEvent) as Record<string, unknown>;
      const event = validateWatchEvent(parsedEvent);
      setPendingWatchEvent(event);
      setPendingWatchEventId(typeof parsedEvent.eventId === "string" ? parsedEvent.eventId : "");
      params.delete("watchEvent");
      const query = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (query ? "?" + query : "") + window.location.hash,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось прочитать событие просмотра.");
    }
  }, []);

  useEffect(() => {
    if (!pendingWatchEvent || watchEventTargetId || library.length === 0) return;
    const matches = findExactAnimeTitleMatches(
      library.map((item) => item.anime),
      pendingWatchEvent.title,
    );
    if (matches.length === 1) setWatchEventTargetId(matches[0]!.id);
  }, [pendingWatchEvent, watchEventTargetId, library]);

  useEffect(() => {
    let cancelled = false;
    let openedRepository: BrowserAnimeRepository | null = null;

    async function initialize() {
      try {
        const databaseName = resolveLibraryDatabaseName(
          window.location.search,
          import.meta.env.DEV,
        );
        const db = await BrowserAnimeRepository.open(databaseName);

        if (cancelled) {
          db.close();
          return;
        }

        openedRepository = db;
        setRepository(db);

        const items = await db.getAll();

        if (!cancelled) {
          setLibrary(items);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Не удалось открыть библиотеку.",
          );
          setLoading(false);
        }
      }
    }

    void initialize();

    return () => {
      cancelled = true;
      openedRepository?.close();
    };
  }, []);

  useEffect(() => {
    if (!historyOpen || !repository) return;
    let active = true;
    setHistoryLoading(true);
    setHistoryError("");
    void Promise.all([repository.getSyncOperations(), repository.getSyncSessions()])
      .then(([operations, sessions]) => {
        if (active) {
          setHistoryOperations(operations);
          setHistorySessionRecords(sessions);
        }
      })
      .catch((err: unknown) => {
        if (active) setHistoryError(err instanceof Error ? err.message : "Не удалось загрузить историю синхронизации.");
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => { active = false; };
  }, [historyOpen, repository]);

  useEffect(() => {
    if (!settingsOpen) return;
    let active = true;
    setIntegrationStatusLoading(true);
    setIntegrationStatusError("");
    void getIntegrationStatus()
      .then((status) => { if (active) setIntegrationStatus(status); })
      .catch((err: unknown) => {
        if (active) setIntegrationStatusError(err instanceof Error ? err.message : "Не удалось получить состояние подключений.");
      })
      .finally(() => { if (active) setIntegrationStatusLoading(false); });
    return () => { active = false; };
  }, [settingsOpen]);

  useEffect(() => {
    if (!searchPageOpen) return;

    function handleSearchKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (selectedAnime) {
          setSelectedAnime(null);
        } else {
          setSearchPageOpen(false);
        }
      }
    }

    window.addEventListener("keydown", handleSearchKeyDown);
    return () => window.removeEventListener("keydown", handleSearchKeyDown);
  }, [searchPageOpen, selectedAnime]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!searchPageOpen || query.length < 2) {
      setCatalogResults([]);
      setCatalogLoading(false);
      setCatalogError("");
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setCatalogLoading(true);
      setCatalogError("");
      void searchAniListAnime(query, controller.signal)
        .then((results) => {
          setCatalogResults(results);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setCatalogError(err instanceof Error ? err.message : "Не удалось выполнить поиск в AniList.");
          setCatalogResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setCatalogLoading(false);
        });
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [searchPageOpen, searchQuery]);

  useEffect(() => {
    const externalId = selectedAnime?.externalIds.anilist;
    if (!selectedAnime) {
      setAnimeDetails(null);
      setDetailsLoading(false);
      setDetailsError("");
      return;
    }
    if (!externalId) {
      setAnimeDetails(null);
      setDetailsLoading(false);
      setDetailsError("Для подробной страницы пока нет AniList ID у этого тайтла.");
      return;
    }

    const controller = new AbortController();
    setDetailsLoading(true);
    setDetailsError("");
    setAnimeDetails(null);

    void fetchAniListAnimeDetails(Number(externalId), controller.signal)
      .then(setAnimeDetails)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setDetailsError(err instanceof Error ? err.message : "Не удалось загрузить информацию об аниме.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailsLoading(false);
      });

    return () => controller.abort();
  }, [selectedAnime]);

  function openAnimeDetails(anime: AnimeIdentity) {
    setSelectedAnime(anime);
  }

  async function addCatalogAnime(anime: AnimeIdentity) {
    if (!repository || addingCatalogId) return;

    setAddingCatalogId(anime.id);
    setCatalogActionMessage("");
    setCatalogError("");

    try {
      const currentItems = await repository.getAll();
      const existing = currentItems.find(({ anime: current }) =>
        current.id === anime.id ||
        (anime.externalIds.myanimelist != null &&
          current.externalIds.myanimelist === anime.externalIds.myanimelist) ||
        (anime.externalIds.anilist != null &&
          current.externalIds.anilist === anime.externalIds.anilist) ||
        (anime.externalIds.shikimori != null &&
          current.externalIds.shikimori === anime.externalIds.shikimori) ||
        (anime.externalIds.yummyanime != null &&
          current.externalIds.yummyanime === anime.externalIds.yummyanime)
      );

      const targetId = existing?.anime.id ?? anime.id;
      const currentAnime = existing?.anime;
      const mergedAnime: AnimeIdentity = {
        ...anime,
        ...(currentAnime ?? {}),
        id: targetId,
        titles: {
          ...anime.titles,
          ...(currentAnime?.titles ?? {}),
          synonyms: [...new Set([
            ...anime.titles.synonyms,
            ...(currentAnime?.titles.synonyms ?? []),
          ])],
        },
        externalIds: {
          ...anime.externalIds,
          ...(currentAnime?.externalIds ?? {}),
          ...(anime.externalIds.anilist
            ? { anilist: anime.externalIds.anilist }
            : {}),
          ...(anime.externalIds.myanimelist
            ? { myanimelist: anime.externalIds.myanimelist }
            : {}),
        },
        year: currentAnime?.year ?? anime.year ?? null,
        ...(currentAnime?.format ?? anime.format
          ? { format: currentAnime?.format ?? anime.format! }
          : {}),
        episodes: currentAnime?.episodes ?? anime.episodes ?? null,
        genres: currentAnime?.genres?.length ? currentAnime.genres : (anime.genres ?? []),
        ageRating: currentAnime?.ageRating ?? anime.ageRating ?? null,
        posterUrl: currentAnime?.posterUrl ?? anime.posterUrl ?? null,
        averageScore: currentAnime?.averageScore ?? anime.averageScore ?? null,
        startDate: currentAnime?.startDate ?? anime.startDate ?? null,
        ...(currentAnime?.releaseStatus ?? anime.releaseStatus
          ? { releaseStatus: currentAnime?.releaseStatus ?? anime.releaseStatus! }
          : {}),
      };

      await repository.saveAnime(mergedAnime);

      if (!existing?.entry) {
        const newEntry: AnimeListEntry = {
          animeId: targetId,
          status: "PLANNING",
          progress: 0,
          score: null,
          favorite: false,
          updatedAt: new Date().toISOString(),
          source: "local",
        };
        await repository.saveEntry(newEntry);
      }

      await refreshLibrary();
      if (pendingWatchEvent) {
        setWatchEventTargetId(targetId);
        setSearchPageOpen(false);
        setSelectedAnime(null);
        setCatalogActionMessage("Аниме добавлено и выбрано для события просмотра. Теперь подтверди обновление прогресса.");
      } else {
        setCatalogActionMessage(existing
          ? "Информация об аниме обновлена. Твоя запись и статус просмотра сохранены."
          : "Аниме добавлено в список «В планах».");
      }
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : "Не удалось добавить аниме.");
    } finally {
      setAddingCatalogId(null);
    }
  }

  function acknowledgePendingWatchEvent() {
    if (pendingWatchEventId) {
      window.postMessage({
        source: "mido-anime-app",
        type: "ACK_WATCH_EVENT",
        eventId: pendingWatchEventId,
      }, window.location.origin);
    }
    setPendingWatchEvent(null);
    setPendingWatchEventId("");
    setWatchEventTargetId("");
  }

  async function applyPendingWatchEvent() {
    if (!repository || !pendingWatchEvent || !watchEventTargetId || watchEventSaving) return;
    const target = library.find((item) => item.anime.id === watchEventTargetId);
    if (!target) {
      setError("Выбранный тайтл больше не найден в библиотеке.");
      return;
    }
    setWatchEventSaving(true);
    setError("");
    try {
      const sourceEntries = await repository.getSourceEntries(target.anime.id);
      const existing = sourceEntries.find((entry) => entry.source === pendingWatchEvent.service);
      const nextEntry = createWatchSourceEntry(target.anime, pendingWatchEvent, existing);
      await repository.saveSourceEntry(nextEntry);
      await refreshLibrary();
      acknowledgePendingWatchEvent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось обновить прогресс просмотра.");
    } finally {
      setWatchEventSaving(false);
    }
  }

  async function importStreamingAccountSnapshot(snapshot: AnimeSnapshotV4, provider: "animego" | "yummyanime") {
    if (!repository) throw new Error("Локальная библиотека ещё не готова.");
    const currentItems = await repository.getAll();
    const reconciled = reconcileStreamingAccountSnapshot(
      snapshot,
      currentItems.map((item) => item.anime),
    );
    // Account-list endpoints often omit progress, score or favorite. Preserve
    // the last known provider value instead of interpreting omission as zero/null/false.
    const sourceEntries = await Promise.all(reconciled.sourceEntries.map(async (entry) => {
      const previous = (await repository!.getSourceEntries(entry.animeId))
        .find((item) => item.source === provider);
      if (!previous) return entry;
      return {
        ...entry,
        ...(entry.sourceMetadata?.progressKnown === false ? { progress: previous.progress } : {}),
        ...(entry.sourceMetadata?.scoreKnown === false ? { score: previous.score } : {}),
        ...(entry.sourceMetadata?.favoriteKnown === false ? { favorite: previous.favorite } : {}),
      };
    }));
    await repository.mergeSnapshot({ ...reconciled, sourceEntries });

    // YummyAnime does not publish an exact premiere date in its anime-card schema.
    // When it supplies an exact MAL ID, resolve missing catalog fields by that ID
    // through AniList rather than guessing dates from the year or title.
    if (provider === "yummyanime") {
      const metadataCandidates = getAniListMetadataCandidates(reconciled.anime);
      if (metadataCandidates.length > 0) {
        setMetadataEnriching(true);
        setMetadataEnrichmentError("");
        setMetadataProgress({
          provider: aniListMetadataProvider.name,
          completed: 0,
          total: metadataCandidates.length,
          matched: 0,
          missing: 0,
        });
        try {
          await aniListMetadataProvider.enrich(reconciled.anime, {
            onBatch: async (batch) => {
              for (const match of batch.matches) {
                await repository!.updateAnimeMetadata(match.animeId, match.metadata);
              }
              setMetadataProgress({
                provider: aniListMetadataProvider.name,
                completed: batch.completed,
                total: batch.total,
                matched: batch.matched,
                missing: batch.missing,
              });
            },
          });
        } catch (metadataError) {
          setMetadataEnrichmentError(
            metadataError instanceof Error
              ? "Импорт YummyAnime выполнен, но часть метаданных AniList не обновлена: " + metadataError.message
              : "Импорт YummyAnime выполнен, но метаданные AniList не удалось обновить.",
          );
        } finally {
          setMetadataEnriching(false);
        }
      }
    }

    await refreshLibrary();
  }

  async function importYummyAnimeSnapshot(snapshot: AnimeSnapshotV4) {
    await importStreamingAccountSnapshot(snapshot, "yummyanime");
  }

  async function importAnimeGoAccountList(payload: AnimeGoAccountListPayload) {
    const normalized = normalizeAnimeGoAccountList(payload);
    const snapshot: AnimeSnapshotV4 = {
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      anime: normalized.rows.map((row) => row.anime),
      entries: [],
      sourceEntries: normalized.rows.map((row) => row.entry),
      conflictResolutions: [],
      animeRelations: [],
    };
    await importStreamingAccountSnapshot(snapshot, "animego");
    window.alert(
      "Импорт AnimeGO завершён. Добавлено или обновлено записей: " +
      normalized.rows.length + ". Пропущено некорректных строк: " + normalized.skipped +
      ". Прогресс и избранное не изменялись.",
    );
  }

  async function prepareAnixartExportImport(file: File): Promise<{ imported: number; skipped: number }> {
    if (!repository) throw new Error("Локальная библиотека ещё не готова.");
    if (file.size > 25 * 1024 * 1024) throw new Error("Файл Anixart слишком большой. Максимум 25 МБ.");
    const result = parseAnixartBookmarkExport(await file.text(), file.name);
    const localAnime = library.map((item) => item.anime);
    const analysis = createImportPreview(result.snapshot.anime, localAnime);
    const suggestions = Object.fromEntries(analysis.items
      .filter((item) => item.status === "new")
      .map((item) => [item.imported.id, suggestTrackerMatches(item.imported, localAnime, 5)])
      .filter(([, matches]) => (matches as TrackerMatchSuggestion[]).length > 0));
    setImportSnapshot(result.snapshot);
    setImportIdentityDiagnostics(null);
    setImportFormat("Anixart export");
    setImportAnalysis(analysis);
    setImportSuggestions(suggestions);
    setImportManualMappings({});
    setError("");
    return { imported: result.snapshot.anime.length, skipped: result.skipped };
  }

  async function refreshLibrary() {
    if (!repository) return;
    setLibrary(await repository.getAll());
  }

  async function runMetadataEnrichment() {
    if (!repository || metadataEnriching) return;

    const db = repository;
    setMetadataEnriching(true);
    setMetadataEnrichmentError("");

    try {
      const currentItems = await db.getAll();
      const identities = currentItems.map((item) => item.anime);
      const validMalIds = new Set(
        identities
          .map((anime) => anime.externalIds.myanimelist)
          .filter((id): id is string => Boolean(id && /^\d+$/.test(id))),
      );
      if (validMalIds.size === 0) {
        setMetadataProgress(null);
        setMetadataEnrichmentError("В библиотеке нет записей с корректным MAL ID для поиска в AniList.");
        return;
      }

      const total = getAniListMetadataCandidates(identities).length;
      if (total === 0) {
        setMetadataProgress({
          provider: aniListMetadataProvider.name,
          completed: 0,
          total: 0,
          matched: 0,
          missing: 0,
        });
        await refreshLibrary();
        return;
      }

      setMetadataProgress({
        provider: aniListMetadataProvider.name,
        completed: 0,
        total,
        matched: 0,
        missing: 0,
      });

      await aniListMetadataProvider.enrich(identities, {
        onBatch: async (batch) => {
          for (const match of batch.matches) {
            await db.updateAnimeMetadata(match.animeId, match.metadata);
          }

          setMetadataProgress((previous) => ({
            provider: aniListMetadataProvider.name,
            completed: batch.completed,
            total: batch.total,
            matched: (previous?.matched ?? 0) + batch.matched,
            missing: (previous?.missing ?? 0) + batch.missing,
          }));
        },
      });

      await refreshLibrary();
    } catch (err) {
      setMetadataEnrichmentError(
        err instanceof Error ? err.message : "Не удалось обновить данные каталога.",
      );
      await refreshLibrary();
    } finally {
      setMetadataEnriching(false);
    }
  }

  function downloadSnapshot(snapshot: AnimeSnapshot) {
    const json = JSON.stringify(snapshot, null, 2);

    const blob = new Blob([json], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    link.href = url;
    link.download = `midahoshi-backup-${timestamp}.json`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function downloadSyncHistory(sessions: SyncSession[], operations: SyncOperation[]) {
    const exportedAt = new Date().toISOString();
    const payload = {
      format: "midahoshi-sync-history",
      schemaVersion: 2,
      exportedAt,
      sessions,
      operations,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = exportedAt.replace(/[:.]/g, "-");

    link.href = url;
    link.download = `midahoshi-sync-history-${timestamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleExport() {
    if (!repository) return;

    try {
      const snapshot = await repository.snapshot();

      downloadSnapshot(snapshot);

      setError("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Не удалось создать резервную копию.",
      );
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    setImportSuggestions({});
    setImportManualMappings({});
    const input = event.currentTarget;
    const file = input.files?.[0];

    if (!file) return;

    try {
      if (file.size > 25 * 1024 * 1024) {
        throw new Error("Файл слишком большой. Максимальный размер: 25 МБ.");
      }

      const isMyAnimeListXml = /\.xml(?:\.gz)?$/i.test(file.name);
      const text = isMyAnimeListXml
        ? await readMyAnimeListExport(file)
        : await file.text();
      const parsed: unknown = isMyAnimeListXml
        ? parseMyAnimeListXml(text)
        : JSON.parse(text);
      const validated = validateSnapshot(parsed);

      const analysis = createImportPreview(
        validated.anime,
        library.map((item) => item.anime),
      );

      setImportSnapshot(validated);
      setImportIdentityDiagnostics(null);
      setImportFormat(isMyAnimeListXml ? "MyAnimeList XML" : `JSON v${validated.schemaVersion}`);
      setImportAnalysis(analysis);
      setError("");
    } catch (err) {
      setImportSnapshot(null);
      setImportAnalysis(null);
      setImportFormat("");
      setImportIdentityDiagnostics(null);

      setError(
        err instanceof Error ? err.message : "Не удалось прочитать файл.",
      );
    } finally {
      input.value = "";
    }
  }

  async function handleRestoreFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      if (!repository) throw new Error("Библиотека ещё не готова.");
      if (syncInProgressRef.current || accountSyncing) {
        throw new Error("Дождись завершения синхронизации перед восстановлением.");
      }
      if (restoreInProgressRef.current || metadataEnriching || importing || restoring || saving || addingCatalogId) {
        throw new Error("Сейчас выполняется другая операция с библиотекой. Попробуй позже.");
      }
      if (file.size > 25 * 1024 * 1024) {
        throw new Error("Файл слишком большой. Максимальный размер: 25 МБ.");
      }

      const parsed: unknown = JSON.parse(await file.text());
      const validated = validateSnapshot(parsed);
      const current = await repository.snapshot();
      const preview = createRestorePreview(validated, current);

      setRestoreBackup(validated);
      setRestorePreview(preview);
      setRestoreFormat(`JSON v${validated.schemaVersion}`);
      setError("");
    } catch (err) {
      setRestoreBackup(null);
      setRestorePreview(null);
      setRestoreFormat("");
      setError(err instanceof Error ? err.message : "Не удалось прочитать резервную копию.");
    } finally {
      input.value = "";
    }
  }

  async function handleConfirmRestore() {
    if (!repository || !restoreBackup || !restorePreview || restoring || restoreInProgressRef.current) return;
    if (syncInProgressRef.current || accountSyncing || metadataEnriching || importing || saving || addingCatalogId) {
      setError("Перед восстановлением дождись завершения синхронизации и других операций с библиотекой.");
      return;
    }

    restoreInProgressRef.current = true;
    setRestoring(true);
    setError("");

    try {
      // Re-check the preview immediately before replacing anything. If the
      // library changed since file selection, require the user to review again.
      const current = await repository.snapshot();
      const freshPreview = createRestorePreview(restoreBackup, current);
      if (JSON.stringify(freshPreview) !== JSON.stringify(restorePreview)) {
        setRestorePreview(freshPreview);
        throw new Error("Библиотека изменилась после предварительного просмотра. Проверь обновлённые изменения и подтверди восстановление ещё раз.");
      }

      // The current library is downloaded as a safety backup before any write.
      downloadSnapshot(current);
      await repository.restoreSnapshot(restoreBackup);
      await refreshLibrary();

      const [operations, sessions] = await Promise.all([
        repository.getSyncOperations(),
        repository.getSyncSessions(),
      ]);
      setHistoryOperations(operations);
      setHistorySessionRecords(sessions);
      setRestoreBackup(null);
      setRestorePreview(null);
      setRestoreFormat("");
      window.alert("Восстановление завершено. Перед заменой библиотеки скачана её предыдущая резервная копия.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось восстановить резервную копию.");
    } finally {
      restoreInProgressRef.current = false;
      setRestoring(false);
    }
  }

  async function handleReconcileIdentityDuplicates() {
    if (!repository || reconcilingDuplicates) return;
    const activeRepository = repository;

    if (syncInProgressRef.current || accountSyncing || restoreInProgressRef.current || metadataEnriching || importing || restoring || saving || addingCatalogId || deletingLibrary) {
      setError("Сначала дождись завершения всех операций с библиотекой и синхронизации.");
      return;
    }

    const pairs = findExactIdentityDuplicatePairs(library.map((item) => item.anime));
    if (pairs.length === 0) {
      window.alert("Точных дублей по внешним ID не найдено.");
      return;
    }

    const confirmed = window.confirm(
      `Найдено ${pairs.length} пар с совпадающими внешними ID. Приложение объединит только однозначные пары, для которых нет двух записей одного сервиса. Исходные записи MAL/AniList и их метаданные будут сохранены отдельно. Перед изменениями скачается резервная копия. Продолжить?`,
    );
    if (!confirmed) return;

    setReconcilingDuplicates(true);
    setError("");

    const reconcile = async () => {
      if (syncInProgressRef.current || accountSyncing || restoreInProgressRef.current || metadataEnriching || importing || restoring || saving || addingCatalogId || deletingLibrary) {
        throw new Error("Появилась другая операция с библиотекой. Объединение отменено.");
      }
      const backup = await activeRepository.snapshot();
      downloadSnapshot(backup);
      const result = await activeRepository.reconcileExactIdentityDuplicates();
      await refreshLibrary();
      window.alert(
        `Объединение завершено. Объединено пар: ${result.mergedPairs}. Пропущено для ручной проверки: ${result.skippedPairs}. Резервная копия скачана.`,
      );
    };

    try {
      if (typeof navigator !== "undefined" && "locks" in navigator) {
        await navigator.locks.request(
          "midahoshi-anime-sync:account-sync",
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            if (!lock) {
              throw new Error("Синхронизация выполняется в другой вкладке. Дождись её завершения и повтори объединение.");
            }
            await reconcile();
          },
        );
      } else {
        await reconcile();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось объединить дубли библиотеки.");
    } finally {
      setReconcilingDuplicates(false);
    }
  }

  async function handleClearLocalLibrary() {
    if (!repository || deletingLibrary) return;
    const activeRepository = repository;
    if (syncInProgressRef.current || accountSyncing || restoreInProgressRef.current || metadataEnriching || importing || restoring || saving || addingCatalogId) {
      setError("Сначала дождись завершения всех операций с библиотекой и синхронизации.");
      return;
    }

    const count = library.length;
    const confirmed = window.confirm(
      `Удалить всю локальную библиотеку? Будет удалено аниме и все локальные записи (${count} тайтлов), исходные записи сервисов, связи, решения конфликтов и ожидающие удаления. Данные на MyAnimeList и AniList НЕ изменятся. История синхронизации и подключения аккаунтов сохранятся. Перед очисткой приложение скачает резервную копию.`,
    );
    if (!confirmed) return;

    const phrase = window.prompt('Это действие нельзя отменить. Введи УДАЛИТЬ для подтверждения:');
    if (phrase !== "УДАЛИТЬ") return;

    setDeletingLibrary(true);
    setError("");

    const clear = async () => {
      if (syncInProgressRef.current || accountSyncing || restoreInProgressRef.current || metadataEnriching || importing || restoring || saving || addingCatalogId) {
        throw new Error("Появилась другая операция с библиотекой. Очистка отменена.");
      }
      const backup = await activeRepository.snapshot();
      downloadSnapshot(backup);
      await activeRepository.clearLibrary();
      await refreshLibrary();

      const [operations, sessions] = await Promise.all([
        activeRepository.getSyncOperations(),
        activeRepository.getSyncSessions(),
      ]);
      setHistoryOperations(operations);
      setHistorySessionRecords(sessions);
      setImportSnapshot(null);
      setImportAnalysis(null);
      setImportFormat("");
      setRestoreBackup(null);
      setRestorePreview(null);
      setRestoreFormat("");
      window.alert("Локальная библиотека очищена. Резервная копия скачана. Данные на MAL и AniList не затронуты.");
    };

    try {
      if (typeof navigator !== "undefined" && "locks" in navigator) {
        await navigator.locks.request(
          "midahoshi-anime-sync:account-sync",
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            if (!lock) {
              throw new Error("Синхронизация выполняется в другой вкладке. Дождись её завершения и повтори очистку.");
            }
            await clear();
          },
        );
      } else {
        await clear();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось очистить локальную библиотеку.");
    } finally {
      setDeletingLibrary(false);
    }
  }

  async function handleImportFromAccount(provider: SyncProvider) {
    if (!repository || importing) return;
    setImportSuggestions({});
    setImportManualMappings({});
    setImporting(true);
    setError("");
    try {
      const payload = await fetchAccountList(provider);
      const snapshot = provider === "mal"
        ? parseMyAnimeListApiList(payload.data)
        : provider === "anilist"
          ? parseAniListAccountList(payload.data, payload.scoreFormat as AniListScoreFormat)
          : parseShikimoriAccountList(payload.data);
      const currentLibrary = await repository.getAll();
      const analysis = createImportPreview(
        snapshot.anime,
        currentLibrary.map((item) => item.anime),
      );
      setImportSnapshot(snapshot);
      setImportFormat(getProviderLabel(provider) + " account");
      setImportAnalysis(analysis);

      if (provider === "shikimori") {
        const importedWithMalId = snapshot.anime.filter((anime) => Boolean(anime.externalIds.myanimelist?.trim()));
        const localMalIds = new Set(
          currentLibrary
            .map((item) => item.anime.externalIds.myanimelist?.trim())
            .filter((id): id is string => Boolean(id)),
        );
        const matchedInLibrary = importedWithMalId.filter((anime) =>
          localMalIds.has(anime.externalIds.myanimelist!.trim()),
        );
        const unmatched = importedWithMalId.filter((anime) =>
          !localMalIds.has(anime.externalIds.myanimelist!.trim()),
        );
        setImportIdentityDiagnostics({
          provider,
          total: snapshot.anime.length,
          withMyAnimeListId: importedWithMalId.length,
          withoutMyAnimeListId: snapshot.anime.length - importedWithMalId.length,
          apiReportedWithMyAnimeListId: payload.identityCoverage?.withMyAnimeListId ?? null,
          matchedInLibrary: matchedInLibrary.length,
          withMyAnimeListIdNotInLibrary: unmatched.length,
          sampleMissingAnimeIds: payload.identityCoverage?.sampleMissingAnimeIds ?? [],
          sampleUnmatchedTitles: unmatched.slice(0, 5).map((anime) =>
            (anime.titles.english ?? anime.titles.romaji ?? anime.titles.native ?? anime.id) +
            " (MAL " + anime.externalIds.myanimelist + ")",
          ),
        });
      } else {
        setImportIdentityDiagnostics(null);
      }
      setSettingsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось получить список из аккаунта.");
    } finally {
      setImporting(false);
    }
  }

  async function handleSyncToAccount(provider: SyncProvider) {
    if (!repository || accountSyncing || syncInProgressRef.current || restoreInProgressRef.current) return;

    // Web Locks prevents another tab from running an account sync while this
    // tab reconciles old sessions. Without it, sync remains available but stale
    // sessions are deliberately not auto-finalized.
    if (typeof navigator === "undefined" || !("locks" in navigator)) {
      await runSyncToAccount(provider, false);
      return;
    }

    try {
      await navigator.locks.request(
        "midahoshi-anime-sync:account-sync",
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            setIntegrationStatusError("Синхронизация уже выполняется в другой вкладке. Дождись её завершения.");
            return;
          }
          await runSyncToAccount(provider, true);
        },
      );
    } catch (err) {
      setIntegrationStatusError(
        err instanceof Error ? err.message : "Не удалось получить блокировку синхронизации.",
      );
    }
  }

  async function runSyncToAccount(
    provider: SyncProvider,
    recoverInterruptedSessions: boolean,
  ) {
    if (!repository || accountSyncing || syncInProgressRef.current || restoreInProgressRef.current) return;
    const activeRepository = repository;
    syncInProgressRef.current = true;
    const sessionId = `sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionStartedAt = new Date().toISOString();
    setAccountSyncing(provider);
    setIntegrationStatusError("");
    try {
      await activeRepository.saveSyncSession({
        sessionId,
        provider,
        status: "running",
        startedAt: sessionStartedAt,
        operationCount: 0,
        succeededCount: 0,
        failedCount: 0,
        pendingCount: 0,
        unchangedCount: 0,
        conflictCount: 0,
        recoveredCount: 0,
      });
      const payload = await fetchAccountList(provider);
      const remoteSnapshot = provider === "mal"
        ? parseMyAnimeListApiList(payload.data)
        : provider === "anilist"
          ? parseAniListAccountList(payload.data, payload.scoreFormat as AniListScoreFormat)
          : parseShikimoriAccountList(payload.data);
      if (payload.count !== remoteSnapshot.entries.length) {
        throw new Error("Количество записей в ответе сервиса не совпадает с разобранным списком. Синхронизация и удаления заблокированы.");
      }
      if (provider === "anilist" && payload.count >= 11000) {
        throw new Error("AniList ограничивает полный MediaListCollection 11 000 записями. Нельзя безопасно определять удаления на таком размере списка.");
      }
      const pendingDeletionIntents = await activeRepository.getDeletionIntents(provider);
      if (pendingDeletionIntents.length > 0 && remoteSnapshot.entries.length === 0) {
        throw new Error("Удалённый сервис вернул пустой список при наличии ожидающих удалений. Запросы на удаление сохранены, синхронизация остановлена.");
      }

      // Reconcile unfinished journal records against the freshly fetched provider
      // snapshot and local source entries before constructing a new sync plan.
      const unfinishedOperations = await activeRepository.getUnfinishedSyncOperations(provider);
      const { recoveredOperations } = await reconcileUnfinishedSyncOperations(
        unfinishedOperations,
        provider,
        remoteSnapshot,
        {
          getSourceEntries: (animeId) => activeRepository.getSourceEntries(animeId),
          updateSyncOperation: (id, update) => activeRepository.updateSyncOperation(id, update),
        },
      );

      const recoveredSessionIds = [...new Set(unfinishedOperations.map((operation) => operation.sessionId))];
      if (recoveredSessionIds.length > 0) {
        const [allJournalOperations, knownSessions] = await Promise.all([
          activeRepository.getSyncOperations(),
          activeRepository.getSyncSessions(),
        ]);
        const knownSessionIds = new Set(knownSessions.map((session) => session.sessionId));
        for (const recoveredSessionId of recoveredSessionIds) {
          // Older journal versions did not persist session metadata.
          if (!knownSessionIds.has(recoveredSessionId)) continue;
          const sessionOperations = allJournalOperations.filter((operation) => operation.sessionId === recoveredSessionId);
          const sessionPending = sessionOperations.filter((operation) => operation.status === "pending" || operation.status === "in_progress").length;
          const sessionFailed = sessionOperations.filter((operation) => operation.status === "failed").length;
          await activeRepository.updateSyncSession(recoveredSessionId, {
            status: sessionPending > 0 ? "running" : sessionFailed > 0 ? "failed" : "succeeded",
            ...(sessionPending === 0 ? { finishedAt: new Date().toISOString() } : {}),
            operationCount: sessionOperations.length,
            succeededCount: sessionOperations.filter((operation) => operation.status === "succeeded").length,
            failedCount: sessionFailed,
            pendingCount: sessionPending,
          });
        }
      }

      if (recoverInterruptedSessions) {
        const [sessions, journalOperations] = await Promise.all([
          activeRepository.getSyncSessions(),
          activeRepository.getSyncOperations(),
        ]);
        await reconcileInterruptedSyncSessions(
          sessionId,
          sessions,
          journalOperations,
          {
            updateSyncSession: (id, update) => activeRepository.updateSyncSession(id, update),
          },
        );
      }

      const baseItems = await activeRepository.getAll();
      const providerSource = getProviderServiceId(provider);
      const localItems = await Promise.all(baseItems.map(async (item) => {
        const sourceEntries = await activeRepository.getSourceEntries(item.anime.id);
        return {
          ...item,
          baseline: sourceEntries.find((entry) => entry.source === providerSource),
        };
      }));
      const plan = createBidirectionalSyncPlan(localItems, remoteSnapshot, provider);
      const deletionDetection = detectRemoteDeletions(localItems, remoteSnapshot, provider);
      if (deletionDetection.blockedReason) throw new Error(deletionDetection.blockedReason);

      const remoteDeletionCandidates = await resolvePendingRemoteDeletionIntents(
        pendingDeletionIntents,
        remoteSnapshot,
        provider,
        (id) => activeRepository.deleteDeletionIntent(id),
      );

      async function saveProviderBaseline(
        snapshot: AnimeSnapshot,
        additionalItems: Array<{ anime: AnimeIdentity }> = [],
      ) {
        const canonicalByExternalId = new Map<string, string>();
        for (const item of [...localItems, ...additionalItems]) {
          const externalId = item.anime.externalIds[providerSource];
          if (externalId) canonicalByExternalId.set(externalId, item.anime.id);
        }
        const baselines: AnimeListEntry[] = [];
        for (const remoteAnime of snapshot.anime) {
          const externalId = remoteAnime.externalIds[providerSource];
          const remoteEntry = snapshot.entries.find((entry) => entry.animeId === remoteAnime.id);
          const canonicalId = externalId ? canonicalByExternalId.get(externalId) : undefined;
          if (!remoteEntry || !canonicalId) continue;
          baselines.push({
            ...remoteEntry,
            animeId: canonicalId,
            source: providerSource,
          });
        }
        await activeRepository.saveSourceEntries(baselines);
      }

      const remoteCreates = [...plan.remoteCreates];
      const remoteUpdates = [...plan.remoteUpdates];
      const pendingDeletionExternalIds = new Set(pendingDeletionIntents.map((intent) => intent.externalId));
      const localCreates = plan.localCreates.filter((change) => !pendingDeletionExternalIds.has(change.anime.externalIds[providerSource] ?? ""));
      const localUpdates = [...plan.localUpdates];

      // Each conflicting anime is resolved explicitly. Cancel or S keeps it untouched.
      const conflictAnimeIds = [...new Set(plan.conflicts.map((conflict) => conflict.animeId))];
      const resolvedConflictAnimeIds = new Set<string>();
      for (const animeId of conflictAnimeIds) {
        const local = localItems.find((item) => item.anime.id === animeId);
        if (!local?.entry) continue;
        const externalId = local.anime.externalIds[providerSource];
        if (!externalId) continue;
        const remoteAnime = remoteSnapshot.anime.find((anime) => anime.externalIds[providerSource] === externalId);
        const remoteEntry = remoteAnime
          ? remoteSnapshot.entries.find((entry) => entry.animeId === remoteAnime.id)
          : undefined;
        if (!remoteEntry) continue;

        const fields = plan.conflicts
          .filter((conflict) => conflict.animeId === animeId)
          .map((conflict) => conflict.field + ": " + String(conflict.localValue) + " ↔ " + String(conflict.remoteValue))
          .join("\n");
        const choice = await new Promise<"l" | "r" | "s">((resolve) => {
          setSyncConflictDialog({
            title: local.anime.titles.english || local.anime.titles.romaji || animeId,
            fields,
            resolve,
          });
        });
        if (choice?.trim().toLowerCase() === "l") {
          resolvedConflictAnimeIds.add(animeId);
          remoteUpdates.push({ externalId, entry: local.entry });
        } else if (choice?.trim().toLowerCase() === "r") {
          resolvedConflictAnimeIds.add(animeId);
          localUpdates.push({
            animeId: local.anime.id,
            entry: {
              ...remoteEntry,
              animeId: local.anime.id,
              source: providerSource,
            },
          });
        }
      }

      const unresolvedDeletionConflictItems: typeof deletionDetection.conflicts = [];
      for (const conflict of deletionDetection.conflicts) {
        const choice = window.prompt(
          "На сервисе удалено аниме «" + conflict.title + "», но локальная запись изменилась после последней синхронизации.\n\nВведи LOCAL, чтобы восстановить запись на сервисе.\nВведи REMOTE, чтобы принять удаление на сервисе и удалить локальную запись этого сервиса.\nОставь поле пустым, чтобы пропустить конфликт.",
        )?.trim().toUpperCase();
        if (choice === "LOCAL") {
          remoteCreates.push({ externalId: conflict.externalId, entry: structuredClone(conflict.localEntry) });
        } else if (choice === "REMOTE") {
          deletionDetection.localRemovals.push({
            animeId: conflict.animeId,
            title: conflict.title,
            externalId: conflict.externalId,
            baseline: structuredClone(conflict.baseline),
          });
        } else {
          unresolvedDeletionConflictItems.push(conflict);
        }
      }
      deletionDetection.conflicts.splice(0, deletionDetection.conflicts.length, ...unresolvedDeletionConflictItems);

      const remoteChanges = remoteCreates.length + remoteUpdates.length + remoteDeletionCandidates.length;
      const localChanges = localCreates.length + localUpdates.length + deletionDetection.localRemovals.length;
      const unresolvedDeletionConflicts = deletionDetection.conflicts.length;
      if (remoteChanges === 0 && localChanges === 0) {
        const unresolved = conflictAnimeIds.filter(
          (id) => !resolvedConflictAnimeIds.has(id),
        ).length + unresolvedDeletionConflicts;
        let baselineMessage = "";
        if (canAdvanceSyncBaseline(0, unresolved)) {
          try {
            // No writes were needed, so the first remote snapshot is still current.
            await saveProviderBaseline(remoteSnapshot);
            baselineMessage = "\nБазовый снимок сервиса обновлён.";
          } catch (err) {
            baselineMessage = "\nНе удалось обновить базовый снимок: " +
              (err instanceof Error ? err.message : "ошибка");
          }
        } else {
          baselineMessage = "\nБазовый снимок не обновлён: остались пропущенные конфликты.";
        }
        await activeRepository.updateSyncSession(sessionId, {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          unchangedCount: plan.unchanged,
          conflictCount: plan.conflicts.length + unresolvedDeletionConflicts,
          recoveredCount: recoveredOperations,
        });
        window.alert(
          "Синхронизация завершена без изменений.\n" +
          "Без изменений: " + plan.unchanged +
          "\nВосстановлено по журналу: " + recoveredOperations +
          "\nКонфликтных полей: " + plan.conflicts.length +
          "\nКонфликтов удаления: " + unresolvedDeletionConflicts +
          "\nПропущено записей без внешнего ID: " + plan.skippedWithoutExternalId +
          baselineMessage,
        );
        return;
      }

      const serviceName = getProviderLabel(provider);
      const deletionNames = [
        ...deletionDetection.localRemovals.map((item) => "• " + item.title + " (удалено на сервисе, будет удалена локальная запись)"),
        ...remoteDeletionCandidates.map((item) => "• " + (item.intent.anime.titles.english || item.intent.anime.titles.romaji || item.intent.animeId) + " (удалено локально, будет удалена запись на сервисе)"),
      ];
      const deletionPreview = deletionNames.length
        ? "\n\nСПИСОК УДАЛЕНИЙ (" + deletionNames.length + "):\n" +
          deletionNames.slice(0, 20).join("\n") +
          (deletionNames.length > 20 ? "\n…и ещё " + (deletionNames.length - 20) : "")
        : "";
      const deletionConflictPreview = deletionDetection.conflicts.length
        ? "\n\nКОНФЛИКТЫ УДАЛЕНИЯ (оставлены без изменений):\n" +
          deletionDetection.conflicts.slice(0, 10).map((item) => "• " + item.title + " (локальная запись изменена после базового снимка)").join("\n") +
          (deletionDetection.conflicts.length > 10 ? "\n…и ещё " + (deletionDetection.conflicts.length - 10) : "")
        : "";
      const confirmed = window.confirm(
        "План синхронизации с " + serviceName + ":" +
        "\nНовые записи на сервисе: " + remoteCreates.length +
        "\nОбновления на сервисе: " + remoteUpdates.length +
        "\nНовые записи в локальной библиотеке: " + localCreates.length +
        "\nОбновления локальной библиотеки: " + localUpdates.length +
        "\nУдаления на сервисе по твоему запросу: " + remoteDeletionCandidates.length +
        "\nУдаления локальных записей после удаления на сервисе: " + deletionDetection.localRemovals.length +
        "\nНеразрешённых конфликтных тайтлов пропущено: " +
          conflictAnimeIds.filter((id) => !resolvedConflictAnimeIds.has(id)).length +
        "\nКонфликтов удаления: " + deletionDetection.conflicts.length +
        (unfinishedOperations.length
          ? "\nНезавершённых операций из прошлых запусков: " + unfinishedOperations.length +
            "\nУже подтверждено сверкой: " + recoveredOperations
          : "") +
        deletionPreview + deletionConflictPreview +
        "\n\nПеред изменениями будет скачана резервная копия. Продолжить?"
      );
      if (!confirmed) {
        await activeRepository.updateSyncSession(sessionId, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          unchangedCount: plan.unchanged,
          conflictCount: plan.conflicts.length + unresolvedDeletionConflicts,
          recoveredCount: recoveredOperations,
        });
        return;
      }
      const deletionCount = deletionDetection.localRemovals.length + remoteDeletionCandidates.length;
      const deletionDenominator = remoteSnapshot.entries.length + deletionDetection.localRemovals.length;
      const requiresBulkConfirmation = deletionCount >= 10 ||
        (deletionDenominator > 0 && deletionCount / deletionDenominator >= 0.25);
      if (requiresBulkConfirmation) {
        const phrase = window.prompt(
          "Обнаружено большое количество удалений (" + deletionCount + "). Для дополнительной защиты введи слово УДАЛИТЬ. Иначе удаление не будет выполнено.",
        );
        if (phrase !== "УДАЛИТЬ") {
          await activeRepository.updateSyncSession(sessionId, {
            status: "cancelled",
            finishedAt: new Date().toISOString(),
            unchangedCount: plan.unchanged,
            conflictCount: plan.conflicts.length + unresolvedDeletionConflicts,
            recoveredCount: recoveredOperations,
          });
          return;
        }
      }

      // Backup is created before the first write to either side.
      downloadSnapshot(await activeRepository.snapshot());

      const journalCreatedAt = new Date().toISOString();
      const remoteChangesToApply = [...remoteCreates, ...remoteUpdates];
      const localChangesToApply = [
        ...localCreates.map((change) => ({
          kind: "create" as const,
          animeId: change.anime.id,
          entry: change.entry,
          anime: change.anime,
        })),
        ...localUpdates.map((change) => ({
          kind: "update" as const,
          animeId: change.animeId,
          entry: change.entry,
        })),
        ...deletionDetection.localRemovals.map((change) => ({
          kind: "delete" as const,
          animeId: change.animeId,
          entry: change.baseline,
          anime: localItems.find((item) => item.anime.id === change.animeId)!.anime,
        })),
      ];
      const remoteJournalOperations: SyncOperation[] = remoteChangesToApply.map((change, index) => {
        const localMatch = localItems.find(
          (item) => item.anime.externalIds[providerSource] === change.externalId,
        );
        const existingRemoteAnime = remoteSnapshot.anime.find(
          (anime) => anime.externalIds[providerSource] === change.externalId,
        );
        const existingRemoteEntry = existingRemoteAnime
          ? remoteSnapshot.entries.find((entry) => entry.animeId === existingRemoteAnime.id)
          : undefined;
        const entryForJournal = structuredClone(change.entry);
        entryForJournal.sourceMetadata = mergeSharedMetadataIntoProviderMetadata(
          provider,
          change.entry.sharedMetadata,
          existingRemoteEntry?.sourceMetadata ?? {},
        );
        return {
          id: `${sessionId}-remote-${index}`,
          sessionId,
          provider,
          direction: "remote",
          kind: index < remoteCreates.length ? "create" : "update",
          animeId: localMatch?.anime.id ?? change.entry.animeId,
          externalId: change.externalId,
          entry: entryForJournal,
          status: "pending",
          attempts: 0,
          createdAt: journalCreatedAt,
          updatedAt: journalCreatedAt,
        };
      });
      const remoteDeletionJournalOperations: SyncOperation[] = remoteDeletionCandidates.map((candidate, index) => ({
        id: `${sessionId}-remote-delete-${index}`,
        sessionId,
        provider,
        direction: "remote",
        kind: "delete",
        animeId: candidate.intent.animeId,
        externalId: candidate.intent.externalId,
        entry: structuredClone(candidate.entry),
        anime: structuredClone(candidate.intent.anime),
        status: "pending",
        attempts: 0,
        createdAt: journalCreatedAt,
        updatedAt: journalCreatedAt,
      }));
      const localJournalOperations: SyncOperation[] = localChangesToApply.map((change, index) => ({
        id: `${sessionId}-local-${index}`,
        sessionId,
        provider,
        direction: "local",
        kind: change.kind,
        animeId: change.animeId,
        entry: structuredClone(change.entry),
        ...(change.kind === "create" || change.kind === "delete" ? { anime: structuredClone(change.anime) } : {}),
        status: "pending",
        attempts: 0,
        createdAt: journalCreatedAt,
        updatedAt: journalCreatedAt,
      }));
      // The entire plan is durable before the first write starts.
      await activeRepository.saveSyncOperations([
        ...remoteJournalOperations,
        ...remoteDeletionJournalOperations,
        ...localJournalOperations,
      ]);
      await activeRepository.updateSyncSession(sessionId, {
        operationCount: remoteJournalOperations.length + remoteDeletionJournalOperations.length + localJournalOperations.length,
        pendingCount: remoteJournalOperations.length + remoteDeletionJournalOperations.length + localJournalOperations.length,
        unchangedCount: plan.unchanged,
        conflictCount: plan.conflicts.length + unresolvedDeletionConflicts,
        recoveredCount: recoveredOperations,
      });

      let remoteSucceeded = 0;
      let localSucceeded = 0;
      let remoteDeleted = 0;
      let localRemoved = 0;
      const failures: string[] = [];

      for (let index = 0; index < remoteChangesToApply.length; index += 1) {
        const change = remoteChangesToApply[index]!;
        const operation = remoteJournalOperations[index]!;
        await activeRepository.updateSyncOperation(operation.id, {
          status: "in_progress",
          attempts: operation.attempts + 1,
        });
        try {
          const existingRemoteAnime = remoteSnapshot.anime.find(
            (anime) => anime.externalIds[providerSource] === change.externalId,
          );
          const existingRemoteEntry = existingRemoteAnime
            ? remoteSnapshot.entries.find((entry) => entry.animeId === existingRemoteAnime.id)
            : undefined;
          const shikimoriRateId = provider === "shikimori"
            ? Number(existingRemoteEntry?.sourceMetadata?.shikimoriRateId)
            : undefined;
          if (provider === "shikimori" && existingRemoteAnime &&
              (!Number.isSafeInteger(shikimoriRateId) || shikimoriRateId! <= 0)) {
            throw new Error("Не удалось определить Shikimori rate ID для обновления записи. Синхронизация не создаст дубликат.");
          }
          await updateAccountEntry(provider, {
            externalId: change.externalId,
            status: change.entry.status,
            progress: change.entry.progress,
            score: change.entry.score,
            ...(provider === "anilist" ? { favorite: change.entry.favorite } : {}),
            sourceMetadata: mergeSharedMetadataIntoProviderMetadata(
              provider,
              change.entry.sharedMetadata,
              existingRemoteEntry?.sourceMetadata ?? {},
            ),
            ...(shikimoriRateId !== undefined ? { entryId: shikimoriRateId } : {}),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "ошибка записи";
          await activeRepository.updateSyncOperation(operation.id, {
            status: "failed",
            error: message,
          });
          failures.push("ID " + change.externalId + " (" + message + ")");
          continue;
        }
        // If this journal update itself fails, the operation remains in_progress.
        // The next run will verify the provider state before deciding what happened.
        await activeRepository.updateSyncOperation(operation.id, { status: "succeeded" });
        remoteSucceeded += 1;
      }

      const deletionResult = await executeRemoteDeletions(
        provider,
        remoteDeletionCandidates,
        remoteDeletionJournalOperations,
        {
          deleteAccountEntry,
          deleteDeletionIntent: (id) => activeRepository.deleteDeletionIntent(id),
          updateSyncOperation: (id, update) => activeRepository.updateSyncOperation(id, update),
        },
      );
      remoteSucceeded += deletionResult.succeeded;
      remoteDeleted += deletionResult.deleted;
      failures.push(...deletionResult.failures);

      for (let index = 0; index < localChangesToApply.length; index += 1) {
        const change = localChangesToApply[index]!;
        const operation = localJournalOperations[index]!;
        await activeRepository.updateSyncOperation(operation.id, {
          status: "in_progress",
          attempts: operation.attempts + 1,
        });
        try {
          if (change.kind === "create") {
            await activeRepository.saveAnimeWithEntry(change.anime, change.entry);
          } else if (change.kind === "update") {
            await activeRepository.saveEntry(change.entry);
          } else {
            await activeRepository.deleteSourceEntry(change.animeId, providerSource);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "ошибка";
          await activeRepository.updateSyncOperation(operation.id, {
            status: "failed",
            error: message,
          });
          failures.push(
            change.animeId +
            (change.kind === "create" ? " (локальное добавление: " : change.kind === "delete" ? " (локальное удаление: " : " (локальное обновление: ") +
            message + ")",
          );
          continue;
        }
        await activeRepository.updateSyncOperation(operation.id, { status: "succeeded" });
        localSucceeded += 1;
        if (change.kind === "delete") localRemoved += 1;
      }

      // A baseline is only safe when every planned write succeeded and no
      // conflict was intentionally skipped. Otherwise the next sync must
      // compare against the previous common state and retry/reconcile safely.
      const unresolvedConflictCount = conflictAnimeIds.filter(
        (id) => !resolvedConflictAnimeIds.has(id),
      ).length + deletionDetection.conflicts.length;
      const warnings: string[] = [];

      if (canAdvanceSyncBaseline(failures.length, unresolvedConflictCount)) {
        // Refresh the provider snapshot and persist it as the next three-way merge baseline.
        try {
          const refreshedPayload = await fetchAccountList(provider);
          const refreshedSnapshot = provider === "mal"
            ? parseMyAnimeListApiList(refreshedPayload.data)
            : provider === "anilist"
              ? parseAniListAccountList(refreshedPayload.data, refreshedPayload.scoreFormat as AniListScoreFormat)
              : parseShikimoriAccountList(refreshedPayload.data);
          if (refreshedPayload.count !== refreshedSnapshot.entries.length) {
            throw new Error("Количество записей в повторном ответе сервиса не совпадает с разобранным списком.");
          }
          if (provider === "anilist" && refreshedPayload.count >= 11000) {
            throw new Error("AniList достиг лимита полного списка в 11 000 записей.");
          }
          await saveProviderBaseline(
            refreshedSnapshot,
            localCreates.map((change) => ({ anime: change.anime })),
          );
        } catch (err) {
          failures.push("Не удалось обновить базовый снимок сервиса: " + (err instanceof Error ? err.message : "ошибка"));
        }
      } else {
        warnings.push(
          "Базовый снимок не обновлён: есть ошибки записи или нерешённые конфликты. Повтори синхронизацию после их устранения.",
        );
      }

      await refreshLibrary();
      const completedOperations = await activeRepository.getSyncOperations();
      const currentSessionOperations = completedOperations.filter((operation) => operation.sessionId === sessionId);
      await activeRepository.updateSyncSession(sessionId, {
        status: failures.length > 0 ? "failed" : "succeeded",
        finishedAt: new Date().toISOString(),
        operationCount: currentSessionOperations.length,
        succeededCount: currentSessionOperations.filter((operation) => operation.status === "succeeded").length,
        failedCount: currentSessionOperations.filter((operation) => operation.status === "failed").length,
        pendingCount: currentSessionOperations.filter((operation) => operation.status === "pending" || operation.status === "in_progress").length,
        unchangedCount: plan.unchanged,
        conflictCount: plan.conflicts.length + deletionDetection.conflicts.length,
        recoveredCount: recoveredOperations,
        ...(failures.length > 0 ? { error: failures.slice(0, 8).join("; ") } : {}),
      });
      window.alert(
        "Двусторонняя синхронизация с " + serviceName + " завершена." +
        "\nУспешно записано на сервис: " + remoteSucceeded +
        "\nУспешно обновлено локально: " + localSucceeded +
        "\nБез изменений: " + plan.unchanged +
        "\nКонфликтных полей: " + plan.conflicts.length +
        "\nКонфликтов удаления: " + deletionDetection.conflicts.length +
        "\nУдалено записей на сервисе: " + remoteDeleted +
        "\nУдалено локальных записей сервиса: " + localRemoved +
        "\nВосстановлено по журналу: " + recoveredOperations +
        "\nОшибок: " + failures.length +
        (failures.length ? "\n" + failures.slice(0, 8).join("\n") : "") +
        (warnings.length ? "\n" + warnings.join("\n") : "") +
        "\n\nРезервная копия скачана."
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось выполнить двустороннюю синхронизацию.";
      setIntegrationStatusError(message);
      try {
        await activeRepository.updateSyncSession(sessionId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: message,
        });
      } catch {
        // Preserve the original sync error if the session journal cannot be updated.
      }
    } finally {
      syncInProgressRef.current = false;
      setAccountSyncing(null);
      void Promise.all([activeRepository.getSyncOperations(), activeRepository.getSyncSessions()])
        .then(([operations, sessions]) => {
          setHistoryOperations(operations);
          setHistorySessionRecords(sessions);
        })
        .catch((err: unknown) => {
          setHistoryError(err instanceof Error ? err.message : "Не удалось обновить историю после синхронизации.");
        });
    }
  }

  async function handleConfirmImport() {
    if (!repository || !importSnapshot || importing) return;
    if (
      importIdentityDiagnostics?.provider === "shikimori" &&
      importIdentityDiagnostics.matchedInLibrary === 0
    ) {
      setError("Импорт Shikimori заблокирован: ни один MAL ID не совпал с локальной библиотекой. Сначала проверь сопоставление идентификаторов.");
      return;
    }

    setImporting(true);
    setError("");

    try {
      const currentLibrary = await repository.getAll();
      const freshAnalysis = createImportPreview(
        importSnapshot.anime,
        currentLibrary.map((item) => item.anime),
      );

      setImportAnalysis(freshAnalysis);

      const mappings: Record<string, string> = {};
      const mappedTargets = new Set<string>();
      let manualMappedCount = 0;

      for (const item of freshAnalysis.items) {
        const selectedTargetId = importManualMappings[item.imported.id];
        const selectedTarget = selectedTargetId
          ? currentLibrary.find((candidate) => candidate.anime.id === selectedTargetId)?.anime
          : null;
        if (selectedTargetId && !selectedTarget) {
          throw new Error("Выбранная запись для ручного сопоставления больше не существует.");
        }
        const match = item.matchedAnime ?? selectedTarget;
        if (!match || match.id === item.imported.id) continue;

        for (const [service, externalId] of Object.entries(item.imported.externalIds)) {
          const existingExternalId = match.externalIds[service as keyof AnimeIdentity["externalIds"]];
          if (existingExternalId && externalId && existingExternalId !== externalId) {
            throw new Error("Нельзя объединить записи: внешний ID " + service + " различается.");
          }
        }
        if (mappedTargets.has(match.id)) {
          throw new Error(
            `Несколько импортируемых записей указывают на один и тот же тайтл в библиотеке: ${match.titles.english ?? match.titles.romaji ?? match.id}.`,
          );
        }

        mappedTargets.add(match.id);
        mappings[item.imported.id] = match.id;
        if (!item.matchedAnime && selectedTarget) manualMappedCount += 1;
      }

      // Автоматически создаём резервную копию перед безопасным добавлением/слиянием.
      const backup = await repository.snapshot();
      downloadSnapshot(backup);

      let snapshotToMerge = importSnapshot;
      if (importSnapshot.schemaVersion === 4) {
        const sourceEntries = await Promise.all(importSnapshot.sourceEntries.map(async (entry) => {
          const targetId = mappings[entry.animeId] ?? entry.animeId;
          const previous = (await repository!.getSourceEntries(targetId))
            .find((existing) => existing.source === entry.source);
          if (!previous) return entry;
          return {
            ...entry,
            ...(entry.sourceMetadata?.progressKnown === false ? { progress: previous.progress } : {}),
            ...(entry.sourceMetadata?.statusKnown === false ? { status: previous.status } : {}),
            ...(entry.sourceMetadata?.scoreKnown === false ? { score: previous.score } : {}),
            ...(entry.sourceMetadata?.favoriteKnown === false ? { favorite: previous.favorite } : {}),
          };
        }));
        snapshotToMerge = { ...importSnapshot, sourceEntries };
      }
      await repository.mergeSnapshotWithMappings(snapshotToMerge, mappings);
      await refreshLibrary();

      const importedCount = freshAnalysis.summary.new - manualMappedCount;
      const matchedCount = freshAnalysis.summary.matched + manualMappedCount;

      setImportSnapshot(null);
      setImportAnalysis(null);
      setImportFormat("");
      setImportSuggestions({});
      setImportManualMappings({});

      window.alert(
        `Импорт завершён! Новых тайтлов добавлено: ${importedCount}. Совпадений объединено: ${matchedCount} (включая ручные сопоставления). Резервная копия скачана.`,
      );
      if (freshAnalysis.items.some((item) => item.imported.externalIds.myanimelist)) {
        void runMetadataEnrichment();
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Не удалось импортировать библиотеку.",
      );
    } finally {
      setImporting(false);
    }
  }

  function openAddModal() {
    setEditingId(null);
    setForm(emptyForm);
    setModalOpen(true);
  }

  function openEditModal(item: LibraryItem) {
    if (!item.entry) return;

    setEditingId(item.anime.id);

    setForm({
      year: item.anime.year?.toString() ?? "",
      format: item.anime.format ?? "",
      genres: item.anime.genres?.join(", ") ?? "",
      ageRating: item.anime.ageRating ?? "",
      posterUrl: item.anime.posterUrl ?? "",
      averageScore: item.anime.averageScore?.toString() ?? "",
      startDate: item.anime.startDate ?? "",
      releaseStatus: item.anime.releaseStatus ?? "",
      title:
        item.anime.titles.english ??
        item.anime.titles.romaji ??
        item.anime.titles.native ??
        "",
      subtitle: item.anime.titles.romaji ?? "",
      episodes: item.anime.episodes?.toString() ?? "",
      progress: item.entry.progress.toString(),
      status: item.entry.status,
      score: item.entry.score?.toString() ?? "",
      favorite: item.entry.favorite,
    });

    setModalOpen(true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!repository || saving) return;

    const title = form.title.trim();
    const progress = Number(form.progress);
    const episodes = form.episodes.trim() === "" ? null : Number(form.episodes);
    const score = form.score.trim() === "" ? null : Number(form.score);
    const year = form.year.trim() === "" ? null : Number(form.year);
    const averageScore = form.averageScore.trim() === "" ? null : Number(form.averageScore);
    const genres = [...new Set(form.genres.split(",").map((genre) => genre.trim()).filter(Boolean))];
    const posterUrl = form.posterUrl.trim();

    if (!title) {
      setError("Укажи название аниме.");
      return;
    }

    if (
      !Number.isInteger(progress) ||
      progress < 0 ||
      (episodes !== null && (!Number.isInteger(episodes) || episodes < 0)) ||
      (episodes !== null && progress > episodes) ||
      (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) ||
      (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2100)) ||
      (averageScore !== null && (!Number.isFinite(averageScore) || averageScore < 0 || averageScore > 10)) ||
      (posterUrl !== "" && !/^https?:\/\//i.test(posterUrl))
    ) {
      setError("Проверь количество серий и оценку.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const id = editingId ?? crypto.randomUUID();

      const previous = editingId
        ? library.find((item) => item.anime.id === editingId)
        : undefined;

      const anime: AnimeIdentity = {
        ...(previous?.anime ?? {}),
        id,
        titles: {
          english: title,
          ...(form.subtitle.trim() ? { romaji: form.subtitle.trim() } : {}),
          synonyms: previous?.anime.titles.synonyms ?? [],
        },
        externalIds: previous?.anime.externalIds ?? {},
        episodes,
        year,
        ...(form.format ? { format: form.format } : {}),
        genres,
        ageRating: form.ageRating || null,
        posterUrl: posterUrl || null,
        averageScore,
        startDate: form.startDate || null,
        ...(form.releaseStatus ? { releaseStatus: form.releaseStatus } : {}),
      };

      const entry: AnimeListEntry = {
        animeId: id,
        status: form.status,
        progress,
        score,
        favorite: form.favorite,
        updatedAt: new Date().toISOString(),
        source: "local",
        ...(previous?.entry?.sourceMetadata
          ? { sourceMetadata: previous.entry.sourceMetadata }
          : {}),
      };

      await repository.saveAnime(anime);
      await repository.saveEntry(entry);

      await refreshLibrary();

      setModalOpen(false);
      setForm(emptyForm);
      setEditingId(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось сохранить аниме.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!repository) return;
    if (syncInProgressRef.current || restoreInProgressRef.current || accountSyncing) {
      setError("Нельзя удалять аниме во время синхронизации или восстановления.");
      return;
    }

    const confirmed = window.confirm(
      "Удалить аниме из локальной библиотеки?\n\nЕсли для него сохранены записи MAL/AniList, приложение запомнит намерение удалить их на соответствующем сервисе при следующей синхронизации. Удаление на сервисе потребует отдельного подтверждения.",
    );
    if (!confirmed) return;

    try {
      const anime = await repository.getAnime(id);
      if (!anime) throw new Error("Аниме уже отсутствует в библиотеке.");
      const sourceEntries = await repository.getSourceEntries(id);
      const createdAt = new Date().toISOString();
      const deletionIntents: SyncDeletionIntent[] = sourceEntries.flatMap((entry) => {
        if (entry.source !== "myanimelist" && entry.source !== "anilist") return [];
        const provider = entry.source === "myanimelist" ? "mal" : "anilist";
        const externalId = anime.externalIds[entry.source];
        if (!externalId) return [];
        return [{
          id: "delete-" + provider + "-" + id + "-" + createdAt,
          provider,
          animeId: id,
          externalId,
          anime: structuredClone(anime),
          entry: structuredClone(entry),
          createdAt,
        }];
      });
      if (deletionIntents.length > 0) {
        downloadSnapshot(await repository.snapshot());
      }
      await repository.deleteAnime(id, deletionIntents);
      await refreshLibrary();
      if (deletionIntents.length > 0) {
        window.alert("Аниме удалено локально. На следующей синхронизации приложение предложит удалить связанные записи на MAL/AniList.");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось удалить аниме.",
      );
    }
  }


  const pendingWatchEventMatches = pendingWatchEvent
    ? findExactAnimeTitleMatches(library.map((item) => item.anime), pendingWatchEvent.title)
    : [];

  const filteredLibrary = useMemo(
    () => filterLibrary(library, filters).sort((a, b) => {
      const titleA = a.anime.titles.english ?? a.anime.titles.romaji ?? "";
      const titleB = b.anime.titles.english ?? b.anime.titles.romaji ?? "";
      return titleA.localeCompare(titleB);
    }),
    [library, filters],
  );
  const selectedManualImportTargets = Object.values(importManualMappings).filter(Boolean);
  const hasDuplicateManualImportTargets = new Set(selectedManualImportTargets).size !== selectedManualImportTargets.length;
  const manualImportMappingCount = selectedManualImportTargets.length;

  const searchResults = useMemo(
    () => filterLibrary(library, { ...filters, query: searchQuery }).sort((a, b) => {
      const titleA = a.anime.titles.english ?? a.anime.titles.romaji ?? "";
      const titleB = b.anime.titles.english ?? b.anime.titles.romaji ?? "";
      return titleA.localeCompare(titleB);
    }),
    [library, filters, searchQuery],
  );

  const genres = [
    "CGDCT", "Авангард", "Антропоморфизм", "Боевые искусства", "Вампиры", "Взрослые персонажи", "Видеоигры", "Военное", "Выживание", "Гарем", "Гонки", "Городское фэнтези", "Гурман", "Гэг-юмор", "Детектив", "Детское", "Дзёсей", "Драма", "Жестокость", "Забота о детях", "Злодейка", "Игра с высокими ставками", "Идолы (Жен.)", "Идолы (Муж.)", "Изобразительное искусство", "Исполнительское искусство", "Исторический", "Исэкай", "Иясикэй", "Командный спорт", "Комедия", "Космос", "Кроссдрессинг", "Культура отаку", "Любовный многоугольник", "Магическая смена пола", "Махо-сёдзё", "Медицина", "Меха", "Мифология", "Музыка", "Образовательное", "Организованная преступность", "Пародия", "Питомцы", "Повседневность", "Приключения", "Психологическое", "Путешествие во времени", "Работа", "Реверс-гарем", "Реинкарнация", "Романтика", "Романтический подтекст", "Самураи", "Сверхъестественное", "Сёдзё", "Сёдзё-ай", "Сёнен", "Сёнен-ай", "Спорт", "Спортивные единоборства", "Стратегические игры", "Супер сила", "Сэйнэн", "Тайна", "Триллер", "Ужасы", "Фантастика", "Фэнтези", "Хентай", "Хулиганы", "Школа", "Шоу-бизнес", "Экшен", "Эротика", "Этти",
  ];

  function toggleArrayFilter<K extends "formats" | "releaseStatuses" | "ageRatings" | "episodeRanges">(
    key: K,
    value: LibraryFilters[K] extends Array<infer T> ? T : never,
  ) {
    setFilters((current) => {
      const values = current[key] as unknown[];
      const next = values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value];
      return { ...current, [key]: next };
    });
  }

  function cycleGenre(genre: string) {
    setFilters((current) => {
      const next = { ...current.genres };
      const mode = next[genre];
      if (!mode) next[genre] = "include";
      else if (mode === "include") next[genre] = "exclude";
      else delete next[genre];
      return { ...current, genres: next };
    });
  }

  const watching = library.filter((item) => item.entry?.status === "WATCHING");

  const completed = library.filter(
    (item) => item.entry?.status === "COMPLETED",
  );

  const favorites = library.filter((item) => item.entry?.favorite);

  const filteredHistoryOperations = historyOperations.filter((operation) =>
    (historyProviderFilter === "all" || operation.provider === historyProviderFilter) &&
    (historyStatusFilter === "all" || operation.status === historyStatusFilter),
  );
  const historySessions = useMemo(() => {
    const operationsBySession = new Map<string, SyncOperation[]>();
    for (const operation of historyOperations) {
      const current = operationsBySession.get(operation.sessionId) ?? [];
      current.push(operation);
      operationsBySession.set(operation.sessionId, current);
    }

    const knownSessionIds = new Set(historySessionRecords.map((session) => session.sessionId));
    const sessions = historySessionRecords
      .filter((session) => historyProviderFilter === "all" || session.provider === historyProviderFilter)
      .map((session) => {
        const operations = (operationsBySession.get(session.sessionId) ?? [])
          .filter((operation) => historyStatusFilter === "all" || operation.status === historyStatusFilter)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return {
          ...session,
          createdAt: session.startedAt,
          operations,
        };
      })
      .filter((session) => historyStatusFilter === "all" || session.operations.length > 0);

    // Keep operations created by older app versions visible even though they have no session record.
    const legacyGroups = new Map<string, SyncOperation[]>();
    for (const operation of filteredHistoryOperations) {
      if (knownSessionIds.has(operation.sessionId)) continue;
      const current = legacyGroups.get(operation.sessionId) ?? [];
      current.push(operation);
      legacyGroups.set(operation.sessionId, current);
    }
    for (const [sessionId, operations] of legacyGroups) {
      sessions.push({
        sessionId,
        provider: operations[0]!.provider,
        status: operations.some((item) => item.status === "cancelled")
          ? "cancelled" as const
          : operations.some((item) => item.status === "failed")
          ? "failed" as const
          : operations.some((item) => item.status === "pending" || item.status === "in_progress")
            ? "running" as const
            : "succeeded" as const,
        startedAt: operations[0]!.createdAt,
        createdAt: operations[0]!.createdAt,
        operationCount: operations.length,
        succeededCount: operations.filter((item) => item.status === "succeeded").length,
        failedCount: operations.filter((item) => item.status === "failed").length,
        pendingCount: operations.filter((item) => item.status === "pending" || item.status === "in_progress").length,
        unchangedCount: 0,
        conflictCount: 0,
        recoveredCount: 0,
        operations,
      });
    }
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [historyOperations, historySessionRecords, filteredHistoryOperations, historyProviderFilter, historyStatusFilter]);

  function formatHistoryDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
  }

  function historyStatusLabel(status: SyncOperation["status"]) {
    return ({
      pending: "Ожидает",
      in_progress: "Выполняется",
      succeeded: "Успешно",
      failed: "Ошибка",
      cancelled: "Прервана",
    })[status];
  }

  function historyAnimeTitle(operation: SyncOperation) {
    const anime = operation.anime ?? library.find((item) => item.anime.id === operation.animeId)?.anime;
    return anime?.titles.english ?? anime?.titles.romaji ?? anime?.titles.native ?? `Аниме ID: ${operation.animeId}`;
  }

  function refreshHistory() {
    if (!repository) return;
    setHistoryLoading(true);
    setHistoryError("");
    void Promise.all([repository.getSyncOperations(), repository.getSyncSessions()])
      .then(([operations, sessions]) => {
        setHistoryOperations(operations);
        setHistorySessionRecords(sessions);
      })
      .catch((err: unknown) => setHistoryError(err instanceof Error ? err.message : "Не удалось обновить историю."))
      .finally(() => setHistoryLoading(false));
  }

  return (
    <div className="app">
      {restoring && (
        <div className="restore-busy-overlay" role="status" aria-live="polite">
          <div>
            <strong>Восстанавливаем библиотеку...</strong>
            <span>Не закрывай вкладку до завершения операции.</span>
          </div>
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">M</div>
          <div>
            <h2>Mido Anime Sync</h2>
            <span>ANIME SYNC</span>
          </div>
        </div>

        <div className="menu-label">МЕНЮ</div>

        <nav className="navigation">
          <button className={"nav-item " + (!historyOpen && !settingsOpen ? "active" : "")} onClick={() => { setHistoryOpen(false); setSettingsOpen(false); }}>
            ▦ <span>Главная</span>
          </button>
          <button className="nav-item" onClick={() => { setHistoryOpen(false); setSettingsOpen(false); setFilters((current) => ({ ...current, status: "ALL" })); }}>
            ▤ <span>Моя библиотека</span>
          </button>
          <button className={"nav-item " + (settingsOpen ? "active" : "")} onClick={() => { setHistoryOpen(false); setSettingsOpen((value) => !value); }}>
            ⇄ <span>Подключения</span>
          </button>
          <button className={"nav-item " + (historyOpen ? "active" : "")} onClick={() => { setSettingsOpen(false); setHistoryOpen(true); }}>
            ◷ <span>История синхронизации</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item" type="button" disabled aria-disabled="true" title="Раздел настроек пока не реализован">
            ⚙ <span>{appLocale === "ru" ? "Настройки" : appLocale === "ja" ? "設定" : "Settings"}</span>
          </button>
          <div className="version">mido-anime-sync v0.5</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Рабочее пространство <span>/</span> {historyOpen ? "История синхронизации" : settingsOpen ? "Подключения" : "Главная"}
          </div>
          <button className="search-launch" onClick={() => setSearchPageOpen(true)} aria-label="Открыть поиск" title="Поиск">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.8" cy="10.8" r="6.8" />
              <path d="m16 16 5 5" />
            </svg>
          </button>
          <div className="profile">
            <div className="avatar">M</div>
            <span>Моя библиотека</span>
          </div>
        </header>

        <div className="content">
          {pendingWatchEvent && (
            <section className="watch-event-panel">
              <div className="watch-event-heading">
                <div>
                  <div className="eyebrow">WATCH EVENT RECEIVED</div>
                  <h2>Новое событие просмотра</h2>
                  <p>
                    {pendingWatchEvent.service === "animego" ? "AnimeGO" : pendingWatchEvent.service === "yummyanime" ? "YummyAnime" : "Anixart"}
                    {" · серия "}{pendingWatchEvent.episode}
                  </p>
                </div>
                <button className="secondary-button" type="button" onClick={acknowledgePendingWatchEvent}>Отменить</button>
              </div>
              <p className="watch-event-title">{pendingWatchEvent.title}</p>
              {pendingWatchEventMatches.length === 0 ? (
                <p className="watch-event-no-match" role="status">
                  «{pendingWatchEvent.title}» пока нет в локальной библиотеке. Найди его в каталоге AniList и добавь, чтобы привязать это событие просмотра.
                </p>
              ) : (
                <p className="watch-event-match-help">Найдено точных совпадений: {pendingWatchEventMatches.length}. Проверь выбранный тайтл перед подтверждением.</p>
              )}
              <label htmlFor="watch-event-anime">Выбрать тайтл вручную из локальной библиотеки</label>
              <select
                id="watch-event-anime"
                className="filter-select watch-event-select"
                value={watchEventTargetId}
                onChange={(event) => setWatchEventTargetId(event.target.value)}
              >
                <option value="">Выбрать аниме…</option>
                {library
                  .slice()
                  .sort((a, b) => (a.anime.titles.english || a.anime.titles.romaji || "").localeCompare(b.anime.titles.english || b.anime.titles.romaji || ""))
                  .map((item) => (
                    <option key={item.anime.id} value={item.anime.id}>
                      {item.anime.titles.english || item.anime.titles.romaji || item.anime.id}
                    </option>
                  ))}
              </select>
              {pendingWatchEventMatches.length === 0 && (
                <button
                  className="secondary-button watch-event-add-button"
                  type="button"
                  onClick={() => {
                    setSearchQuery(pendingWatchEvent.title);
                    setCatalogActionMessage("");
                    setCatalogError("");
                    setHideAnimeInMyLists(false);
                    setSelectedAnime(null);
                    setSearchPageOpen(true);
                  }}
                >
                  ＋ Найти и добавить аниме
                </button>
              )}
              <div className="watch-event-meta">
                <span>Позиция: {pendingWatchEvent.currentTimeSeconds == null ? "не определена" : Math.floor(pendingWatchEvent.currentTimeSeconds / 60) + " мин."}</span>
                <span>Источник: {new URL(pendingWatchEvent.sourceUrl).hostname}</span>
              </div>
              <button
                className="add-button"
                type="button"
                disabled={!watchEventTargetId || watchEventSaving}
                onClick={() => void applyPendingWatchEvent()}
              >
                {watchEventSaving ? "Сохраняем прогресс…" : "Подтвердить и обновить прогресс"}
              </button>
            </section>
          )}
          {settingsOpen && (
            <section className="integration-settings">
              <article className="integration-provider">
                <div className="integration-provider-info">
                  <h3>{t(appLocale, "language")}</h3>
                  <p>{appLocale === "ru" ? "Язык интерфейса и текстов каталога" : appLocale === "ja" ? "インターフェースとカタログの表示言語" : "Interface and catalog display language"}</p>
                </div>
                <select aria-label={t(appLocale, "language")} value={appLocale} onChange={(event) => {
                  const next = event.target.value as AppLocale;
                  setAppLocale(next);
                  saveAppLocale(next);
                }}>
                  <option value="ru">{t(appLocale, "russian")}</option>
                  <option value="en">{t(appLocale, "english")}</option>
                  <option value="ja">{t(appLocale, "japanese")}</option>
                </select>
              </article>
              <div className="section-heading">
                <div>
                  <div className="eyebrow">ACCOUNT CONNECTIONS</div>
                  <h2>{appLocale === "ru" ? "Подключение аккаунтов" : appLocale === "ja" ? "アカウント接続" : "Account connections"}</h2>
                  <p>Авторизация проходит на официальных сайтах. Пароли от аккаунтов приложение не запрашивает.</p>
                </div>
                <button className="secondary-button" onClick={() => {
                  setIntegrationStatusLoading(true);
                  void getIntegrationStatus()
                    .then(setIntegrationStatus)
                    .catch((err: unknown) => setIntegrationStatusError(err instanceof Error ? err.message : "Не удалось обновить состояние."))
                    .finally(() => setIntegrationStatusLoading(false));
                }} disabled={integrationStatusLoading}>
                  {integrationStatusLoading ? "Проверка..." : "Обновить"}
                </button>
              </div>
              {integrationStatusError && <div className="error-message">{integrationStatusError}</div>}
              {(["myanimelist", "anilist", "shikimori"] as const).map((provider) => {
                const label = provider === "myanimelist" ? "MyAnimeList" : provider === "anilist" ? "AniList" : "Shikimori";
                const status = integrationStatus?.[provider];
                const routeProvider: SyncProvider = provider === "myanimelist" ? "mal" : provider;
                return (
                  <article className="integration-provider" key={provider}>
                    <div className={"integration-provider-mark integration-provider-mark--" + provider}>
                      <img
                        src={"/integrations/" + provider + ".svg"}
                        alt={label + " logo"}
                        width="28"
                        height="28"
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                      />
                    </div>
                    <div className="integration-provider-info">
                      <h3>{label}</h3>
                      <p>
                        {integrationStatusLoading && !status
                          ? "Проверяем подключение..."
                          : !integrationStatus
                            ? "Локальный API-сервер не отвечает."
                            : !status?.configured
                              ? (routeProvider === "mal" ? "Нужно добавить MAL_CLIENT_ID в .env.local." : routeProvider === "anilist" ? "Нужно добавить ANILIST_CLIENT_ID и ANILIST_CLIENT_SECRET в .env.local." : "Нужно добавить SHIKIMORI_CLIENT_ID и SHIKIMORI_CLIENT_SECRET в .env.local.")
                              : status.connected
                                ? "Подключён аккаунт: " + (status.username || "пользователь")
                                : "Приложение настроено, аккаунт ещё не подключён."}
                      </p>
                    </div>
                    <div className={"integration-state " + (status?.connected ? "connected" : "")}>
                      {status?.connected ? "Подключён" : status?.configured ? "Не подключён" : "Не настроен"}
                    </div>
                    {status?.connected ? (
                      <>
                        <button className="add-button" disabled={importing} onClick={() => void handleImportFromAccount(routeProvider)}>
                          {importing ? "Загружаем..." : "Импорт списка"}
                        </button>
                        <button className="secondary-button" disabled={accountSyncing !== null} onClick={() => void handleSyncToAccount(routeProvider)}>
                          {accountSyncing === routeProvider ? "Синхронизируем..." : "Синхронизировать"}
                        </button>
                        <button className="secondary-button" onClick={() => {
                          void disconnectIntegration(routeProvider)
                            .then(() => getIntegrationStatus())
                            .then(setIntegrationStatus)
                            .catch((err: unknown) => setIntegrationStatusError(err instanceof Error ? err.message : "Не удалось отключить аккаунт."));
                        }}>Отключить</button>
                      </>
                    ) : (
                      <button className="add-button" disabled={!status?.configured || integrationStatusLoading} onClick={() => connectIntegration(routeProvider)}>
                        Подключить аккаунт
                      </button>
                    )}
                  </article>
                );
              })}
              <StreamingTrackerPanel
                items={library}
                onImportAnixart={prepareAnixartExportImport}
                onImport={async (rows) => {
                  const snapshot: AnimeSnapshotV4 = {
                    schemaVersion: 4,
                    exportedAt: new Date().toISOString(),
                    anime: rows.map((row) => row.anime),
                    entries: [],
                    sourceEntries: rows.map((row) => row.entry),
                    conflictResolutions: [],
                    animeRelations: [],
                  };
                  await importYummyAnimeSnapshot(snapshot);
                }}
              />
              <div className="integration-security-note">
                <strong>Безопасность:</strong> токены сохраняются локально в зашифрованном виде. Не публикуй .env.local и папку .local-data.
              </div>
              <div className="integration-danger-zone">
                <div>
                  <h3>Исправление дублей библиотеки</h3>
                  <p>Ищет записи с одинаковыми внешними ID разных сервисов. Перед объединением скачивается резервная копия. Неоднозначные совпадения и пары с двумя записями одного сервиса пропускаются.</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleReconcileIdentityDuplicates()}
                  disabled={reconcilingDuplicates || deletingLibrary || loading || library.length < 2 || syncInProgressRef.current || accountSyncing !== null || restoring || importing || metadataEnriching || saving || addingCatalogId !== null}
                >
                  {reconcilingDuplicates ? "Проверяем и объединяем..." : "Найти и объединить точные дубли"}
                </button>
              </div>
              <div className="integration-danger-zone">
                <div>
                  <h3>Очистка локальной библиотеки</h3>
                  <p>Удаляет все локальные записи и данные библиотеки. Аккаунты MAL и AniList, а также данные на самих сервисах не затрагиваются. Перед очисткой автоматически скачивается резервная копия.</p>
                </div>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void handleClearLocalLibrary()}
                  disabled={deletingLibrary || loading || library.length === 0 || syncInProgressRef.current || accountSyncing !== null || restoring || importing || metadataEnriching || saving || addingCatalogId !== null}
                >
                  {deletingLibrary ? "Очищаем библиотеку..." : "Удалить всю локальную библиотеку"}
                </button>
              </div>
            </section>
          )}
          {historyOpen ? (
            <section className="sync-history-page">
              <div className="history-heading">
                <div>
                  <div className="eyebrow">SYNC ACTIVITY</div>
                  <h1>История синхронизации</h1>
                  <p>Все запуски синхронизации, включая сеансы без изменений, и подробности каждой операции</p>
                </div>
                <div className="history-heading-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => downloadSyncHistory(historySessionRecords, historyOperations)}
                    disabled={historyOperations.length === 0 && historySessionRecords.length === 0}
                    title="Экспортировать все сеансы и операции, включая скрытые текущими фильтрами"
                  >
                    ↓ Экспорт JSON
                  </button>
                  <button className="secondary-button" type="button" onClick={refreshHistory} disabled={historyLoading || !repository}>
                    {historyLoading ? "Обновляем..." : "↻ Обновить"}
                  </button>
                </div>
              </div>

              {historyError && <div className="error-message" role="alert">{historyError}</div>}

              <div className="history-overview">
                <article><span>Всего сеансов</span><strong>{historySessionRecords.length}</strong></article>
                <article><span>Без изменений</span><strong>{historySessionRecords.filter((session) => session.status === "succeeded" && session.operationCount === 0).length}</strong></article>
                <article><span>Успешные сеансы</span><strong className="history-count-success">{historySessionRecords.filter((session) => session.status === "succeeded").length}</strong></article>
                <article><span>Сеансы с ошибками</span><strong className="history-count-failed">{historySessionRecords.filter((session) => session.status === "failed").length}</strong></article>
                <article><span>Всего операций</span><strong>{historyOperations.length}</strong></article>
              </div>

              <div className="history-toolbar">
                <label>
                  Сервис
                  <select className="filter-select" value={historyProviderFilter} onChange={(event) => setHistoryProviderFilter(event.target.value as typeof historyProviderFilter)}>
                    <option value="all">Все сервисы</option>
                    <option value="mal">MyAnimeList</option>
                    <option value="anilist">AniList</option>
                    <option value="shikimori">Shikimori</option>
                  </select>
                </label>
                <label>
                  Статус
                  <select className="filter-select" value={historyStatusFilter} onChange={(event) => setHistoryStatusFilter(event.target.value as typeof historyStatusFilter)}>
                    <option value="all">Все статусы</option>
                    <option value="pending">Ожидает</option>
                    <option value="in_progress">Выполняется</option>
                    <option value="succeeded">Успешно</option>
                    <option value="failed">Ошибка</option>
                    <option value="cancelled">Прервана</option>
                  </select>
                </label>
                <span>{filteredHistoryOperations.length} операций · {historySessions.length} сеансов</span>
              </div>

              {historyLoading && historyOperations.length === 0 ? (
                <div className="empty-state"><div className="empty-icon">◷</div><h3>Загружаем историю</h3><p>Читаем журнал из локальной базы данных.</p></div>
              ) : historySessions.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">◷</div>
                  <h3>{historyOperations.length === 0 ? "История пока пуста" : "Ничего не найдено"}</h3>
                  <p>{historyOperations.length === 0 && historySessionRecords.length === 0 ? "Когда ты запустишь синхронизацию с MAL или AniList, каждый запуск появится здесь, даже если изменений не будет." : "Измени фильтры, чтобы увидеть другие сеансы и операции."}</p>
                </div>
              ) : (
                <div className="history-session-list">
                  {historySessions.map((session) => {
                    const succeeded = session.operations.filter((item) => item.status === "succeeded").length;
                    const failed = session.operations.filter((item) => item.status === "failed").length;
                    const pending = session.operations.filter((item) => item.status === "pending" || item.status === "in_progress").length;
                    const hasUnfinished = failed > 0 || pending > 0 || session.status === "running" || session.status === "failed";
                    return (
                      <section className="history-session" key={session.sessionId}>
                        <header className="history-session-header">
                          <div>
                            <span className="history-session-date">{formatHistoryDate(session.createdAt)}</span>
                            <h2>{getProviderLabel(session.provider)}</h2>
                            <small>{session.sessionId}</small>
                            <span className={"history-session-status " + session.status}>
                              {session.status === "running" ? "Выполняется" : session.status === "succeeded" ? "Успешно" : session.status === "failed" ? "Ошибка" : "Отменено"}
                            </span>
                          </div>
                          <div className="history-session-summary">
                            <span className="history-count-success">✓ {succeeded}</span>
                            {pending > 0 && <span className="history-count-pending">◷ {pending}</span>}
                            {failed > 0 && <span className="history-count-failed">! {failed}</span>}
                            <span>{session.operationCount} операций</span>
                            {session.unchangedCount > 0 && <span>{session.unchangedCount} без изменений</span>}
                            {hasUnfinished && (
                              <button
                                className="secondary-button"
                                type="button"
                                disabled={accountSyncing !== null}
                                onClick={() => void handleSyncToAccount(session.provider)}
                                title="Сначала заново сверить текущее состояние сервиса, затем построить новый план"
                              >
                                {accountSyncing === session.provider ? "Сверяем..." : "Пересверить и продолжить"}
                              </button>
                            )}
                          </div>
                        </header>
                        <div className="history-operation-list">
                          {session.operations.map((operation) => (
                            <details className={"history-operation " + operation.status} key={operation.id}>
                              <summary>
                                <span className={"history-status-dot " + operation.status} />
                                <span className="history-operation-title">
                                  <strong>{historyAnimeTitle(operation)}</strong>
                                  <small>
                                    {operation.direction === "remote" ? "Отправка в сервис" : "Запись в библиотеку"}
                                    {" · "}{operation.kind === "create" ? "Создание" : operation.kind === "delete" ? "Удаление" : "Обновление"}
                                    {" · "}{getProviderLabel(operation.provider)}
                                  </small>
                                </span>
                                <span className={"history-status-label " + operation.status}>{historyStatusLabel(operation.status)}</span>
                                <span className="history-operation-time">{formatHistoryDate(operation.updatedAt)}</span>
                              </summary>
                              <div className="history-operation-details">
                                <div><span>Статус просмотра</span><strong>{statusLabels[operation.entry.status]}</strong></div>
                                <div><span>Прогресс</span><strong>{operation.entry.progress} эп.</strong></div>
                                <div><span>Оценка</span><strong>{operation.entry.score == null || operation.entry.score === 0 ? "Не оценено" : operation.entry.score + " / 100"}</strong></div>
                                {operation.provider === "anilist" && <div><span>Избранное</span><strong>{operation.entry.favorite ? "Да" : "Нет"}</strong></div>}
                                {operation.externalId && <div><span>Внешний ID</span><strong>{operation.externalId}</strong></div>}
                                <div><span>Попыток</span><strong>{operation.attempts}</strong></div>
                                {operation.error && <div className="history-operation-error"><span>Ошибка</span><strong>{operation.error}</strong></div>}
                              </div>
                            </details>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </section>
          ) : (
            <>
          <section className="welcome">
            <div>
              <div className="eyebrow">ТВОЯ АНИМЕ-ВСЕЛЕННАЯ</div>
              <h1>
                Добро пожаловать! <span>✦</span>
              </h1>
              <p>Всё твоё аниме. В одном месте. Без хаоса.</p>
            </div>

            <button className="add-button" onClick={openAddModal}>
              ＋ Добавить аниме
            </button>
          </section>

          {error && (
            <div className="error-message">
              {error}
              <button onClick={() => setError("")}>×</button>
            </div>
          )}

          <section className="stats">
            <div className="stat-card">
              <div className="stat-icon purple-bg">▤</div>
              <div className="stat-name">Всего в библиотеке</div>
              <div className="stat-number">
                {loading ? "..." : library.length}
              </div>
              <div className="stat-note">Записей аниме</div>
            </div>

            <div className="stat-card">
              <div className="stat-icon green-bg">✓</div>
              <div className="stat-name">Просмотрено</div>
              <div className="stat-number">{completed.length}</div>
              <div className="stat-note">Завершённых тайтлов</div>
            </div>

            <div className="stat-card">
              <div className="stat-icon blue-bg">◷</div>
              <div className="stat-name">Смотрю сейчас</div>
              <div className="stat-number">{watching.length}</div>
              <div className="stat-note">Активных тайтлов</div>
            </div>

            <div className="stat-card">
              <div className="stat-icon orange-bg">★</div>
              <div className="stat-name">Избранное</div>
              <div className="stat-number">{favorites.length}</div>
              <div className="stat-note">Любимые произведения</div>
            </div>
          </section>

          <section className="sync-card">
            <div className="sync-symbol">⇄</div>
            <div className="sync-info">
              <h3>Синхронизация библиотек</h3>
              <p>Подключи MyAnimeList и AniList, чтобы читать и синхронизировать личные списки.</p>
            </div>
            <div className="sync-status">
              <span className="status-dot" />
              Локальная библиотека
            </div>
            <button className="secondary-button" onClick={() => setSettingsOpen(true)}>
              Подключить →
            </button>
          </section>

          <section className="sync-card">
            <div className="sync-symbol">💾</div>

            <div className="sync-info">
              <h3>Резервная копия и перенос</h3>
              <p>
                Сохраняй библиотеку в файл или восстанавливай её из резервной
                копии.
              </p>
            </div>

            <button
              className="secondary-button"
              onClick={() => void handleExport()}
              disabled={loading || !repository}
            >
              ↓ Экспорт JSON
            </button>

            <button
              className="secondary-button"
              type="button"
              onClick={() => restoreFileInputRef.current?.click()}
              disabled={loading || !repository || importing || restoring || accountSyncing !== null || metadataEnriching || saving || addingCatalogId !== null}
            >
              ↻ Восстановить резервную копию
            </button>
            <input
              ref={restoreFileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleRestoreFile}
              disabled={loading || !repository || importing || restoring || accountSyncing !== null || metadataEnriching || saving || addingCatalogId !== null}
              style={{ display: "none" }}
            />

            <label className="secondary-button">
              ↑ Импорт JSON / MAL XML
              <input
                type="file"
                accept=".json,.xml,.xml.gz,.gz,application/json,text/xml,application/xml,application/gzip,application/x-gzip"
                onChange={handleImportFile}
                disabled={loading || !repository || importing}
                style={{ display: "none" }}
              />
            </label>
          </section>

          {restoreBackup && restorePreview && (
            <section className="import-preview restore-preview">
              <div className="import-preview-heading">
                <div>
                  <div className="eyebrow">FULL RESTORE</div>
                  <h2>Предварительный просмотр восстановления</h2>
                  <p>Это полная замена библиотеки данными из резервной копии, а не обычное добавление или объединение.</p>
                </div>
                <button
                  className="small-action"
                  onClick={() => {
                    setRestoreBackup(null);
                    setRestorePreview(null);
                    setRestoreFormat("");
                  }}
                  disabled={restoring}
                >
                  Отменить
                </button>
              </div>

              <div className="import-summary restore-summary">
                <div className="import-summary-card"><span>Всего изменений</span><strong>{restorePreview.summary.total}</strong></div>
                <div className="import-summary-card new"><span>Добавится</span><strong>{restorePreview.summary.added}</strong></div>
                <div className="import-summary-card matched"><span>Обновится</span><strong>{restorePreview.summary.updated}</strong></div>
                <div className="import-summary-card review"><span>Будет удалено</span><strong>{restorePreview.summary.removed}</strong></div>
                <div className="import-summary-card"><span>Без изменений</span><strong>{restorePreview.summary.unchanged}</strong></div>
              </div>

              <div className="restore-collections">
                {([
                  ["Аниме", restorePreview.collections.anime],
                  ["Записи сервисов", restorePreview.collections.sourceEntries],
                  ["Решения конфликтов", restorePreview.collections.conflictResolutions],
                  ["Связи аниме", restorePreview.collections.animeRelations],
                  ["Ожидающие удаления", restorePreview.collections.deletionIntents],
                ] as const).map(([label, counts]) => (
                  <div className="restore-collection-row" key={label}>
                    <strong>{label}</strong>
                    <span>+{counts.added} · обновится {counts.updated} · удалится {counts.removed}</span>
                  </div>
                ))}
              </div>

              {restorePreview.conflicts.length > 0 && (
                <div className="import-safety-note">
                  <strong>Изменения внешних ID: {restorePreview.conflicts.length}</strong>
                  <p>В резервной копии отличаются внешние идентификаторы MAL/AniList. При полном восстановлении будут использованы значения из резервной копии.</p>
                </div>
              )}

              <div className="restore-warning">
                <strong>Внимание: текущая библиотека будет заменена целиком.</strong>
                <p>Записи, которых нет в резервной копии, будут удалены. Перед восстановлением приложение автоматически скачает текущую библиотеку отдельным JSON-файлом. Незавершённые операции синхронизации будут отмечены как прерванные. Ожидающие удаления из резервной копии также будут восстановлены и потребуют подтверждения при следующей синхронизации.</p>
                <p>Файл: {restoreFormat}. После проверки нажми «Восстановить библиотеку» для подтверждения.</p>
              </div>

              <div className="import-actions">
                <button
                  className="secondary-button"
                  onClick={() => {
                    setRestoreBackup(null);
                    setRestorePreview(null);
                    setRestoreFormat("");
                  }}
                  disabled={restoring}
                >
                  Отмена
                </button>
                <button
                  className="add-button restore-confirm-button"
                  onClick={() => void handleConfirmRestore()}
                  disabled={restoring || accountSyncing !== null || metadataEnriching || importing || saving || addingCatalogId !== null}
                >
                  {restoring ? "Восстановление..." : "Восстановить библиотеку"}
                </button>
              </div>
            </section>
          )}

          {importSnapshot && importAnalysis && (
            <section className="import-preview">
              <div className="import-preview-heading">
                <div>
                  <div className="eyebrow">IMPORT CENTER</div>
                  <h2>Предварительный просмотр импорта</h2>
                  <p>
                    {importFormat === "Anixart export"
                      ? "Совпадения по точным ID объединяются автоматически. Похожие названия показаны только как подсказки и объединяются лишь после твоего выбора."
                      : "Новые тайтлы будут добавлены автоматически. Совпадения определяются только по точным ID, а похожие названия не объединяются."}
                  </p>
                </div>

                <button
                  className="small-action"
                  onClick={() => {
                    setImportSnapshot(null);
                    setImportAnalysis(null);
                                 setImportFormat("");
                  }}
                  disabled={importing}
                >
                  Отменить импорт
                </button>
              </div>

              <div className="import-summary">
                <div className="import-summary-card">
                  <span>Всего</span>
                  <strong>{importAnalysis.summary.total}</strong>
                </div>

                <div className="import-summary-card new">
                  <span>Новые</span>
                  <strong>{Math.max(0, importAnalysis.summary.new - (importFormat === "Anixart export" ? manualImportMappingCount : 0))}</strong>
                </div>

                <div className="import-summary-card matched">
                  <span>Совпадения</span>
                  <strong>{importAnalysis.summary.matched + (importFormat === "Anixart export" ? manualImportMappingCount : 0)}</strong>
                </div>

              </div>

              <div className="import-file-info">
                <span>Формат: {importFormat || `JSON v${importSnapshot.schemaVersion}`}</span>
                <span>Записей библиотеки: {importSnapshot.entries.length}</span>
                {importSnapshot.schemaVersion === 4 && <span>Записей источника: {importSnapshot.sourceEntries.length}</span>}
              </div>

              {importFormat === "Anixart export" && Object.keys(importSuggestions).length > 0 && (
                <div className="import-title-suggestions">
                  <strong>Ручное сопоставление похожих названий</strong>
                  <p>Предлагаемые совпадения не применяются автоматически. Выбери правильный тайтл или оставь запись отдельной.</p>
                  {Object.entries(importSuggestions).map(([importedId, suggestions]) => {
                    const imported = importSnapshot.anime.find((anime) => anime.id === importedId);
                    if (!imported) return null;
                    return (
                      <label key={importedId}>
                        <span>{imported.titles.english ?? imported.titles.romaji ?? imported.id}</span>
                        <select
                          value={importManualMappings[importedId] ?? ""}
                          onChange={(event) => setImportManualMappings((previous) => ({
                            ...previous,
                            [importedId]: event.target.value,
                          }))}
                          disabled={importing}
                        >
                          <option value="">Оставить отдельной записью</option>
                          {suggestions.map((suggestion) => (
                            <option
                              key={suggestion.anime.id}
                              value={suggestion.anime.id}
                              disabled={Object.entries(importManualMappings).some(([otherId, targetId]) => otherId !== importedId && targetId === suggestion.anime.id) || importAnalysis.items.some((item) => item.imported.id !== importedId && item.matchedAnime?.id === suggestion.anime.id)}
                            >
                              {suggestion.anime.titles.english ?? suggestion.anime.titles.romaji ?? suggestion.anime.id}
                              {" · совпадение "}{Math.round(suggestion.score * 100)}%
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}

              {importIdentityDiagnostics?.provider === "shikimori" && (
                <div className="import-safety-note">
                  <strong>Проверка связей Shikimori ↔ MyAnimeList</strong>
                  <p>
                    MAL ID найдено: {importIdentityDiagnostics.withMyAnimeListId} из {importIdentityDiagnostics.total}.
                    Без MAL ID: {importIdentityDiagnostics.withoutMyAnimeListId}.
                    Совпадений с локальной библиотекой по MAL ID: {importIdentityDiagnostics.matchedInLibrary}.
                  </p>
                  {importIdentityDiagnostics.apiReportedWithMyAnimeListId !== null &&
                    importIdentityDiagnostics.apiReportedWithMyAnimeListId !== importIdentityDiagnostics.withMyAnimeListId && (
                      <p>
                        Внимание: сервер сообщил {importIdentityDiagnostics.apiReportedWithMyAnimeListId} MAL ID, но парсер распознал {importIdentityDiagnostics.withMyAnimeListId}. Проверь формат ответа API.
                      </p>
                    )}
                  {importIdentityDiagnostics.sampleMissingAnimeIds.length > 0 && (
                    <p>Примеры Shikimori ID без MAL ID: {importIdentityDiagnostics.sampleMissingAnimeIds.join(", ")}.</p>
                  )}
                  {importIdentityDiagnostics.sampleUnmatchedTitles.length > 0 && (
                    <p>Примеры MAL ID, которых нет в локальной библиотеке: {importIdentityDiagnostics.sampleUnmatchedTitles.join("; ")}.</p>
                  )}
                  {importIdentityDiagnostics.matchedInLibrary === 0 && (
                    <p>Импорт заблокирован: нет ни одного подтверждённого совпадения с библиотекой. Новые записи не будут добавлены.</p>
                  )}
                </div>
              )}

              {hasDuplicateManualImportTargets && (
                <div className="import-safety-note">
                  <strong>Повторное сопоставление.</strong>
                  <p>Один локальный тайтл выбран для нескольких записей экспорта. Выбери разные цели или оставь лишние записи отдельными.</p>
                </div>
              )}

              <div className="import-safety-note">
                <strong>Готово к импорту.</strong>
                <p>
                  Будут добавлены все новые тайтлы. Уже известные записи объединяются
                  только при совпадении внутреннего или внешнего ID. Похожие названия
                  с разными ID останутся отдельными тайтлами. Существующие записи,
                  которых нет в файле, сохранятся. Перед импортом автоматически
                  скачается резервная копия.
                </p>
              </div>

              <div className="import-actions">
                <button
                  className="secondary-button"
                  onClick={() => {
                    setImportSnapshot(null);
                    setImportAnalysis(null);
                                 setImportFormat("");
                  }}
                  disabled={importing}
                >
                  Отмена
                </button>

                <button
                  className="add-button"
                  onClick={() => void handleConfirmImport()}
                  disabled={
                    importing ||
                    hasDuplicateManualImportTargets ||
                    (importIdentityDiagnostics?.provider === "shikimori" &&
                      importIdentityDiagnostics.matchedInLibrary === 0)
                  }
                >
                  {importing ? "Импорт..." : `Импортировать ${importSnapshot.anime.length} аниме`}
                </button>
              </div>
            </section>
          )}

          <section className="anime-section">
            <div className="section-heading">
              <div>
                <h2>Моя библиотека</h2>
                <p>
                  {loading
                    ? "Загружаем данные..."
                    : `Найдено: ${filteredLibrary.length} из ${library.length}`}
                </p>
              </div>
            </div>

            <div className="library-toolbar">
              <button className="secondary-button" onClick={() => setSearchPageOpen(true)}>⌕ Поиск аниме</button>
              <button className="secondary-button" onClick={() => setFiltersOpen((value) => !value)}>
                ⚙ Фильтры {filtersOpen ? "−" : "+"}
              </button>
              <span className="filter-result-count">{filteredLibrary.length} результатов</span>
            </div>

            {library.some((item) => item.anime.externalIds.myanimelist) && (
              <button
                className="secondary-button metadata-refresh-button"
                onClick={() => void runMetadataEnrichment()}
                disabled={metadataEnriching}
              >
                {metadataEnriching ? "Обновляем данные..." : "↻ Обновить данные каталога"}
              </button>
            )}

            {(metadataProgress || metadataEnrichmentError) && (
              <div className="metadata-progress" role="status">
                <div className="metadata-progress-heading">
                  <strong>{metadataEnriching ? "Обогащаем библиотеку" : "Обновление каталожных данных"}</strong>
                  {metadataProgress && <span>{metadataProgress.completed} / {metadataProgress.total}</span>}
                </div>
                {metadataProgress && (
                  <>
                    <progress value={metadataProgress.completed} max={metadataProgress.total || 1} />
                    <p>
                      Источник: {metadataProgress.provider}. Найдено: {metadataProgress.matched}.
                      Не найдено: {metadataProgress.missing}.
                    </p>
                  </>
                )}
                {metadataEnrichmentError && <p className="metadata-progress-error">{metadataEnrichmentError}</p>}
                {!metadataEnriching && metadataEnrichmentError && (
                  <button className="small-action" onClick={() => void runMetadataEnrichment()}>
                    Повторить
                  </button>
                )}
                {!metadataEnriching && !metadataEnrichmentError && metadataProgress && metadataProgress.completed === metadataProgress.total && (
                  <p className="metadata-progress-success">Обогащение завершено. Личные статусы, оценки и прогресс сохранены.</p>
                )}
              </div>
            )}

            {filtersOpen && (
              <div className="library-filters">
                <div className="filter-section">
                  <h3>Год выхода <span title="Диапазон годов выпуска аниме">ⓘ</span></h3>
                  <div className="year-range">
                    <label>От <input type="number" min="1959" max={new Date().getFullYear() + 1} value={filters.yearFrom} onChange={(event) => setFilters((v) => ({ ...v, yearFrom: Math.max(1959, Number(event.target.value) || 1959) }))} /></label>
                    <label>До <input type="number" min="1959" max={new Date().getFullYear() + 1} value={filters.yearTo} onChange={(event) => setFilters((v) => ({ ...v, yearTo: Math.min(new Date().getFullYear() + 1, Math.max(v.yearFrom, Number(event.target.value) || v.yearFrom)) }))} /></label>
                  </div>
                </div>
                <div className="filter-section">
                  <h3>Статус в списке</h3>
                  <div className="filter-options">
                    <label><input type="radio" checked={filters.status === "ALL"} onChange={() => setFilters((v) => ({ ...v, status: "ALL" }))} /> Все</label>
                    {Object.entries(statusLabels).map(([value, label]) => <label key={value}><input type="radio" checked={filters.status === value} onChange={() => setFilters((v) => ({ ...v, status: value as LibraryFilters["status"] }))} /> {label}</label>)}
                  </div>
                </div>
                <div className="filter-section">
                  <h3>Жанры <span title="Нажми повторно: пусто → включить → исключить">ⓘ</span></h3>
                  <p className="filter-hint">Нажимай на жанр, чтобы включить его, исключить или сбросить.</p>
                  <div className="genre-grid">
                    {genres.map((genre) => <button type="button" key={genre} className={`genre-chip ${filters.genres[genre] ?? ""}`} onClick={() => cycleGenre(genre)}>{filters.genres[genre] === "include" ? "＋ " : filters.genres[genre] === "exclude" ? "− " : ""}{genre}</button>)}
                  </div>
                  <label className="filter-check"><input type="checkbox" checked={filters.strictGenres} onChange={(event) => setFilters((v) => ({ ...v, strictGenres: event.target.checked }))} /> Строгое совпадение <span title="Включено: должны совпасть все выбранные жанры. Выключено: достаточно любого выбранного жанра.">ⓘ</span></label>
                </div>
                <div className="filter-section">
                  <h3>Тип</h3><div className="filter-options">
                    {([["TV","Сериал"],["MOVIE","Фильм"],["SPECIAL","Спешл"],["OVA","OVA"],["ONA","ONA"]] as const).map(([value,label]) => <label key={value}><input type="checkbox" checked={filters.formats.includes(value)} onChange={() => toggleArrayFilter("formats", value)} /> {label}</label>)}
                  </div>
                </div>
                <div className="filter-section">
                  <h3>Статус выхода <span title="Статус релиза самого аниме, а не твоего просмотра">ⓘ</span></h3><div className="filter-options">
                    {([["ONGOING","Онгоинг"],["ANNOUNCED","Анонс"],["RELEASED","Вышел"]] as const).map(([value,label]) => <label key={value}><input type="checkbox" checked={filters.releaseStatuses.includes(value)} onChange={() => toggleArrayFilter("releaseStatuses", value)} /> {label}</label>)}
                    <label><input type="checkbox" checked={filters.recentOnly} onChange={(event) => setFilters((v) => ({ ...v, recentOnly: event.target.checked }))} /> Недавно <span title="Премьера за последние 6 месяцев">ⓘ</span></label>
                  </div>
                </div>
                <div className="filter-section">
                  <h3>Возрастной рейтинг <span title="G: без ограничений. PG: рекомендуется присутствие родителей. PG-13: не рекомендуется детям до 13 лет. R-17: до 17 лет только со взрослым. R+: просмотр до 17 лет запрещён.">ⓘ</span></h3>
                  <div className="filter-options">{(["G","PG","PG13","R17","R+"] as const).map((value) => <label key={value}><input type="checkbox" checked={filters.ageRatings.includes(value)} onChange={() => toggleArrayFilter("ageRatings", value)} /> {value === "PG13" ? "PG-13" : value === "R17" ? "R-17" : value}</label>)}</div>
                </div>
                <div className="filter-section">
                  <h3>Количество эпизодов <span title="Короткие: до 13. Средние: 14–26. Длинные: 27–100. Очень длинные: более 100.">ⓘ</span></h3>
                  <div className="filter-options">{([["SHORT","Короткие (до 13)"],["MEDIUM","Средние (14–26)"],["LONG","Длинные (27–100)"],["VERY_LONG","Очень длинные (более 100)"]] as const).map(([value,label]) => <label key={value}><input type="checkbox" checked={filters.episodeRanges.includes(value)} onChange={() => toggleArrayFilter("episodeRanges", value)} /> {label}</label>)}</div>
                </div>
                <div className="filter-actions"><button className="cancel-button" onClick={() => setFilters(DEFAULT_LIBRARY_FILTERS)}>Сбросить фильтры</button><button className="add-button" onClick={() => setFiltersOpen(false)}>Применить</button></div>
              </div>
            )}

            {loading ? (
              <div className="empty-state">Загружаем библиотеку...</div>
            ) : filteredLibrary.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">✦</div>
                <h3>
                  {library.length === 0
                    ? "Твоя библиотека пока пуста"
                    : "Ничего не найдено"}
                </h3>
                <p>
                  {library.length === 0
                    ? "Добавь первое аниме или позже импортируй свою коллекцию."
                    : "Попробуй изменить запрос или фильтр."}
                </p>
                {library.length === 0 && (
                  <button className="add-button" onClick={openAddModal}>
                    ＋ Добавить первое аниме
                  </button>
                )}
              </div>
            ) : (
              <div className="anime-list">
                {filteredLibrary.map(({ anime, entry }) => {
                  const title =
                    anime.titles.english ??
                    anime.titles.romaji ??
                    anime.titles.native ??
                    "Без названия";

                  const totalEpisodes = anime.episodes;
                  const progressKnown = entry?.sourceMetadata?.progressKnown !== false;
                  const progress = progressKnown ? entry?.progress ?? 0 : null;

                  const percent =
                    progress !== null && typeof totalEpisodes === "number" && totalEpisodes > 0
                      ? Math.min(100, Math.round((progress / totalEpisodes) * 100))
                      : 0;
                  const releaseStatusLabel = anime.releaseStatus === "ONGOING"
                    ? "Выходит"
                    : anime.releaseStatus === "ANNOUNCED"
                      ? "Анонсировано"
                      : anime.releaseStatus === "RELEASED"
                        ? "Завершено"
                        : null;

                  return (
                    <article className="anime-card" key={anime.id}>
                      <AnimeCover url={anime.posterUrl ?? null} score={anime.averageScore ?? null} />

                      <div className="anime-details">
                        <h3>{title}</h3>
                        <p className="anime-subtitle">{anime.titles.romaji ?? " "}</p>
                        <div className="anime-catalog-meta">
                          {[anime.format, anime.year, anime.ageRating, anime.startDate, releaseStatusLabel, anime.episodes != null ? `${anime.episodes} эп.` : null, ...(anime.genres ?? [])].filter(Boolean).join(" · ") || "Метаданные пока не добавлены"}
                        </div>

                        {entry && (
                          <>
                            <div className="anime-meta">
                              <span className="status-label">
                                {entry.source === "anixart" && entry.sourceMetadata?.statusKnown === false && entry.favorite ? "Избранное" : statusLabels[entry.status]}
                              </span>

                              {entry.favorite && (
                                <span className="favorite-label">★</span>
                              )}

                              {entry.score !== null && (
                                <span className="score-label">
                                  Оценка: {entry.score}/100
                                </span>
                              )}
                            </div>

                            <div className="progress-info">
                              <span>
                                {progress === null
                                  ? `Прогресс просмотра не предоставлен${typeof totalEpisodes === "number" ? ` · всего ${totalEpisodes} эп.` : ""}`
                                  : typeof totalEpisodes === "number" && totalEpisodes > 0
                                    ? `Эпизод ${progress} из ${totalEpisodes}`
                                    : `Просмотрено ${progress} эпизодов`}
                              </span>

                              <span>
                                {progress !== null && typeof totalEpisodes === "number" && totalEpisodes > 0 ? `${percent}%` : ""}
                              </span>
                            </div>

                            {progress !== null && typeof totalEpisodes === "number" &&
                              totalEpisodes > 0 && (
                                <div className="progress-track">
                                  <div
                                    className="progress-fill purple"
                                    style={{ width: `${percent}%` }}
                                  />
                                </div>
                              )}
                          </>
                        )}
                      </div>

                      <div className="card-actions">
                        <button
                          className="small-action"
                          onClick={() =>
                            entry ? openEditModal({ anime, entry }) : undefined
                          }
                          disabled={!entry}
                        >
                          Изменить
                        </button>

                        <button
                          className="small-action delete-action"
                          onClick={() => void handleDelete(anime.id)}
                        >
                          Удалить
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <footer>
            <span>mido-anime-sync</span>
            <span>Твоя библиотека. Твои правила.</span>
          </footer>
            </>
          )}
        </div>
      </main>

      {searchPageOpen && (
        <div className="search-page">
          <header className="search-page-header">
            <h1>Поиск</h1>
          </header>
          <div className="search-page-content">
            <div className="search-input-wrap">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.8" cy="10.8" r="6.8" />
                <path d="m16 16 5 5" />
              </svg>
              <input autoFocus className="search-input" type="search" aria-label="Поиск по моей библиотеке" placeholder="Аниме" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            </div>
            <div className="search-results-heading"><h2>В моей библиотеке</h2><span>{searchResults.length}</span></div>
            {searchQuery.trim().length < 2 ? (
              <div className="catalog-hint">Введи хотя бы 2 символа, чтобы искать в своей библиотеке и общем каталоге AniList.</div>
            ) : searchResults.length === 0 ? (
              <div className="catalog-hint">В своей библиотеке ничего не найдено.</div>
            ) : (
              <div className="search-results-list">
                {searchResults.map(({ anime, entry }) => <article className="search-result-card" key={anime.id}>
                  <div className="search-result-poster">{anime.posterUrl ? <img src={anime.posterUrl} alt="" loading="lazy" /> : <span>✦</span>}{anime.averageScore != null && <b className={`poster-score ${anime.averageScore >= 8 ? "excellent" : anime.averageScore >= 7 ? "good" : anime.averageScore >= 5 ? "average" : "poor"}`}>{anime.averageScore.toFixed(1)}</b>}</div>
                  <div className="search-result-details"><button className="detail-title-button" disabled={!anime.externalIds.anilist} title={!anime.externalIds.anilist ? "Подробная страница пока недоступна для этого источника" : "Открыть подробную страницу"} onClick={() => openAnimeDetails(anime)}>{anime.titles.english ?? anime.titles.romaji ?? anime.titles.native ?? "Без названия"}</button><p>{anime.titles.romaji ?? anime.titles.native ?? ""}</p><div>{anime.format ?? "Формат не указан"}{anime.year ? ` · ${anime.year}` : ""}</div><small>{(anime.genres ?? []).join(" · ") || "Жанры пока не добавлены"}</small>{entry && <span className="status-label">{statusLabels[entry.status]}</span>}</div>
                </article>)}
              </div>
            )}

            <div className="catalog-heading-row">
              <div className="search-results-heading"><h2>В каталоге AniList</h2><span>{catalogResults.filter((anime) => !hideAnimeInMyLists || !library.some(({ anime: local }) => local.id === anime.id || (anime.externalIds.myanimelist != null && local.externalIds.myanimelist === anime.externalIds.myanimelist) || (anime.externalIds.anilist != null && local.externalIds.anilist === anime.externalIds.anilist))).length}</span></div>
              <label className="catalog-hide-toggle"><input type="checkbox" checked={hideAnimeInMyLists} onChange={(event) => setHideAnimeInMyLists(event.target.checked)} /> Скрыть аниме из моих списков</label>
            </div>
            {catalogLoading && <p className="catalog-hint">Ищем аниме в AniList...</p>}
            {catalogError && <p className="catalog-error" role="alert">{catalogError}</p>}
            {catalogActionMessage && <p className="catalog-success" role="status">{catalogActionMessage}</p>}
            {searchQuery.trim().length >= 2 && !catalogLoading && !catalogError && catalogResults.length === 0 && <p className="catalog-hint">В каталоге AniList ничего не найдено.</p>}
            {catalogResults.length > 0 && (
              <div className="search-results-list">
                {catalogResults
                  .filter((anime) => !hideAnimeInMyLists || !library.some(({ anime: local }) =>
                    local.id === anime.id ||
                    (anime.externalIds.myanimelist != null && local.externalIds.myanimelist === anime.externalIds.myanimelist) ||
                    (anime.externalIds.anilist != null && local.externalIds.anilist === anime.externalIds.anilist)
                  ))
                  .map((anime) => {
                    const existing = library.find(({ anime: local }) =>
                      local.id === anime.id ||
                      (anime.externalIds.myanimelist != null && local.externalIds.myanimelist === anime.externalIds.myanimelist) ||
                      (anime.externalIds.anilist != null && local.externalIds.anilist === anime.externalIds.anilist)
                    );
                    return <article className="search-result-card" key={anime.id}>
                      <div className="search-result-poster">{anime.posterUrl ? <img src={anime.posterUrl} alt="" loading="lazy" /> : <span>✦</span>}{anime.averageScore != null && <b className={`poster-score ${anime.averageScore >= 8 ? "excellent" : anime.averageScore >= 7 ? "good" : anime.averageScore >= 5 ? "average" : "poor"}`}>{anime.averageScore.toFixed(1)}</b>}</div>
                      <div className="search-result-details">
                        <button className="detail-title-button" onClick={() => openAnimeDetails(anime)}>{anime.titles.english ?? anime.titles.romaji ?? anime.titles.native ?? "Без названия"}</button>
                        <p>{anime.titles.romaji ?? anime.titles.native ?? ""}</p>
                        <div>{anime.format ?? "Формат не указан"}{anime.year ? ` · ${anime.year}` : ""}{anime.episodes ? ` · ${anime.episodes} эп.` : ""}</div>
                        <small>{(anime.genres ?? []).join(" · ")}</small>
                        <button className="catalog-add-button" disabled={addingCatalogId !== null} onClick={() => void addCatalogAnime(anime)}>
                          {addingCatalogId === anime.id ? "Сохраняем..." : pendingWatchEvent ? "＋ Добавить и выбрать для просмотра" : existing?.entry ? "Обновить данные" : existing ? "Добавить в список" : "＋ Добавить в библиотеку"}
                        </button>
                      </div>
                    </article>;
                  })}
              </div>
            )}
            <StreamingCatalogPanel query={searchQuery} onImport={addCatalogAnime} onImportSnapshot={importYummyAnimeSnapshot} locale={appLocale} />
          </div>
        </div>
      )}

      {searchPageOpen && selectedAnime && (
        <div className="anime-detail-overlay">
          <section className="anime-detail-page" role="dialog" aria-modal="true" aria-labelledby="anime-detail-title">
            <header className="anime-detail-header">
              <span>Страница аниме</span>
              <button type="button" onClick={() => setSelectedAnime(null)} aria-label="Закрыть страницу аниме">×</button>
            </header>
            {detailsLoading && <p className="catalog-hint">Загружаем подробную информацию...</p>}
            {detailsError && <p className="catalog-error" role="alert">{detailsError}</p>}
            {animeDetails && (
              <>
                {animeDetails.bannerImage && <div className="anime-detail-banner" style={{ backgroundImage: `linear-gradient(90deg, #101016 0%, #10101655 100%), url("${animeDetails.bannerImage}")` }} />}
                <div className="anime-detail-main">
                  <img className="anime-detail-poster" src={animeDetails.anime.posterUrl ?? selectedAnime.posterUrl ?? ""} alt="" />
                  <div className="anime-detail-heading">
                    <h1 id="anime-detail-title">{animeDetails.anime.titles.english ?? animeDetails.anime.titles.romaji ?? animeDetails.anime.titles.native}</h1>
                    <p>{animeDetails.anime.titles.romaji ?? ""}</p>
                    {animeDetails.anime.titles.native && <p>{animeDetails.anime.titles.native}</p>}
                    <div className="anime-detail-tags">
                      <span>{animeDetails.anime.format ?? "Формат не указан"}</span>
                      {animeDetails.anime.year && <span>{animeDetails.anime.year}</span>}
                      {animeDetails.anime.episodes && <span>{animeDetails.anime.episodes} эп.</span>}
                      {animeDetails.anime.averageScore != null && <strong>★ {animeDetails.anime.averageScore.toFixed(1)}</strong>}
                    </div>
                    <div className="anime-detail-genres">{(animeDetails.anime.genres ?? []).map((genre) => <span key={genre}>{genre}</span>)}</div>
                  </div>
                </div>
                <div className="anime-detail-body">
                  <section>
                    <h2>Описание</h2>
                    <p className="anime-detail-description">{animeDetails.description || "Описание пока отсутствует в AniList."}</p>
                  </section>
                  <section className="anime-detail-facts">
                    <h2>Информация</h2>
                    <dl>
                      <div><dt>Статус выхода</dt><dd>{animeDetails.anime.releaseStatus === "ONGOING" ? "Выходит" : animeDetails.anime.releaseStatus === "ANNOUNCED" ? "Анонсировано" : animeDetails.anime.releaseStatus === "RELEASED" ? "Вышло" : "Не указан"}</dd></div>
                      <div><dt>Премьера</dt><dd>{animeDetails.anime.startDate ?? "Не указана"}</dd></div>
                      <div><dt>Сезон</dt><dd>{animeDetails.season ? `${animeDetails.season} ${animeDetails.seasonYear ?? ""}`.trim() : "Не указан"}</dd></div>
                      <div><dt>Длительность эпизода</dt><dd>{animeDetails.duration ? `${animeDetails.duration} мин.` : "Не указана"}</dd></div>
                      <div><dt>Первоисточник</dt><dd>{animeDetails.source ?? "Не указан"}</dd></div>
                      <div><dt>Студия</dt><dd>{animeDetails.studios.join(", ") || "Не указана"}</dd></div>
                    </dl>
                  </section>
                  {animeDetails.relations.length > 0 && (
                    <section>
                      <h2>Связанные произведения</h2>
                      <div className="anime-relations-grid">
                        {animeDetails.relations.map(({ relationType, anime }) => (
                          <button type="button" className="anime-relation-card" key={`${relationType}-${anime.id}`} onClick={() => openAnimeDetails(anime)}>
                            {anime.posterUrl ? <img src={anime.posterUrl} alt="" loading="lazy" /> : <span className="anime-relation-placeholder">✦</span>}
                            <span><small>{relationType.replaceAll("_", " ")}</small><strong>{anime.titles.english ?? anime.titles.romaji ?? anime.titles.native ?? "Без названия"}</strong><small>{anime.format ?? "Аниме"}{anime.year ? ` · ${anime.year}` : ""}</small></span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {syncConflictDialog && (
        <div className="modal-overlay" role="presentation">
          <section className="anime-modal sync-conflict-modal" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
            <div className="modal-heading">
              <div>
                <h2 id="sync-conflict-title">Конфликт синхронизации</h2>
                <p>{syncConflictDialog.title}</p>
              </div>
            </div>
            <pre className="sync-conflict-fields">{syncConflictDialog.fields}</pre>
            <p className="sync-conflict-help">Выбери, какую версию сохранить. Если пропустить, этот тайтл не будет изменён.</p>
            <div className="modal-actions sync-conflict-actions">
              <button type="button" className="cancel-button" onClick={() => {
                const resolve = syncConflictDialog.resolve;
                setSyncConflictDialog(null);
                resolve("s");
              }}>Пропустить</button>
              <button type="button" className="cancel-button" onClick={() => {
                const resolve = syncConflictDialog.resolve;
                setSyncConflictDialog(null);
                resolve("r");
              }}>Принять версию сервиса</button>
              <button type="button" className="add-button" onClick={() => {
                const resolve = syncConflictDialog.resolve;
                setSyncConflictDialog(null);
                resolve("l");
              }}>Оставить локальную</button>
            </div>
          </section>
        </div>
      )}

      {modalOpen && (
        <div
          className="modal-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) {
              setModalOpen(false);
            }
          }}
        >
          <form className="anime-modal" onSubmit={handleSubmit}>
            <div className="modal-heading">
              <div>
                <h2>{editingId ? "Редактировать аниме" : "Новое аниме"}</h2>
                <p>Заполни информацию о тайтле</p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() => setModalOpen(false)}
                disabled={saving}
              >
                ×
              </button>
            </div>

            <label>
              Название *
              <input
                required
                value={form.title}
                onChange={(event) =>
                  setForm({ ...form, title: event.target.value })
                }
                placeholder="Например, Frieren"
              />
            </label>

            <label>
              Альтернативное название
              <input
                value={form.subtitle}
                onChange={(event) =>
                  setForm({ ...form, subtitle: event.target.value })
                }
                placeholder="Например, Sousou no Frieren"
              />
            </label>

            <div className="form-grid">
              <label>
                Год выхода
                <input type="number" min="1900" max="2100" value={form.year} onChange={(event) => setForm({ ...form, year: event.target.value })} placeholder="2026" />
              </label>
              <label>
                Тип аниме
                <select value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value as AnimeFormat | "" })}>
                  <option value="">Не указан</option>
                  <option value="TV">Сериал</option><option value="MOVIE">Фильм</option><option value="SPECIAL">Спешл</option><option value="OVA">OVA</option><option value="ONA">ONA</option><option value="MUSIC">Музыкальное</option>
                </select>
              </label>
            </div>

            <label>
              Жанры (через запятую)
              <input value={form.genres} onChange={(event) => setForm({ ...form, genres: event.target.value })} placeholder="Фэнтези, Приключения, Драма" />
            </label>

            <div className="form-grid">
              <label>
                Возрастной рейтинг
                <select value={form.ageRating} onChange={(event) => setForm({ ...form, ageRating: event.target.value as AnimeAgeRating | "" })}>
                  <option value="">Не указан</option><option value="G">G</option><option value="PG">PG</option><option value="PG13">PG-13</option><option value="R17">R-17</option><option value="R+">R+</option>
                </select>
              </label>
              <label>
                Рейтинг (0–10)
                <input type="number" min="0" max="10" step="0.1" value={form.averageScore} onChange={(event) => setForm({ ...form, averageScore: event.target.value })} placeholder="8.5" />
              </label>
            </div>

            <label>
              Ссылка на постер
              <input type="url" value={form.posterUrl} onChange={(event) => setForm({ ...form, posterUrl: event.target.value })} placeholder="https://..." />
            </label>

            <div className="form-grid">
              <label>
                Дата премьеры
                <input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} />
              </label>
              <label>
                Статус выхода
                <select value={form.releaseStatus} onChange={(event) => setForm({ ...form, releaseStatus: event.target.value as AnimeReleaseStatus | "" })}>
                  <option value="">Не указан</option><option value="ONGOING">Онгоинг</option><option value="ANNOUNCED">Анонс</option><option value="RELEASED">Вышел</option>
                </select>
              </label>
            </div>

            <div className="form-grid">
              <label>
                Всего эпизодов
                <input
                  type="number"
                  min="0"
                  value={form.episodes}
                  onChange={(event) =>
                    setForm({ ...form, episodes: event.target.value })
                  }
                  placeholder="28"
                />
              </label>

              <label>
                Просмотрено
                <input
                  type="number"
                  min="0"
                  value={form.progress}
                  onChange={(event) =>
                    setForm({ ...form, progress: event.target.value })
                  }
                />
              </label>
            </div>

            <div className="form-grid">
              <label>
                Статус
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      status: event.target.value as AnimeStatus,
                    })
                  }
                >
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Оценка (0–100)
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={form.score}
                  onChange={(event) =>
                    setForm({ ...form, score: event.target.value })
                  }
                  placeholder="Не оценено"
                />
              </label>
            </div>

            <label className="favorite-checkbox">
              <input
                type="checkbox"
                checked={form.favorite}
                onChange={(event) =>
                  setForm({ ...form, favorite: event.target.checked })
                }
              />
              Добавить в избранное ★
            </label>

            <div className="modal-actions">
              <button
                type="button"
                className="cancel-button"
                onClick={() => setModalOpen(false)}
                disabled={saving}
              >
                Отмена
              </button>

              <button type="submit" className="add-button" disabled={saving}>
                {saving ? "Сохранение..." : "Сохранить"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
