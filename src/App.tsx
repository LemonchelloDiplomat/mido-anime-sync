import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import type {
  AnimeIdentity,
  AnimeAgeRating,
  AnimeFormat,
  AnimeReleaseStatus,
  AnimeListEntry,
  AnimeSnapshot,
  AnimeStatus,
  SyncOperation,
} from "./core/types.js";

import { BrowserAnimeRepository } from "./storage/browser-repository.js";
import { validateSnapshot } from "./storage/snapshot-validation.js";
import { DEFAULT_LIBRARY_FILTERS, filterLibrary, type LibraryFilters } from "./core/library-filter.js";
import { aniListMetadataProvider, fetchAniListAnimeDetails, getAniListMetadataCandidates, searchAniListAnime, type AniListAnimeDetails } from "./services/anilist.js";
import { parseMyAnimeListXml, readMyAnimeListExport } from "./services/myanimelist-import.js";
import { connectIntegration, disconnectIntegration, getIntegrationStatus, type IntegrationStatus } from "./services/integrations-api.js";
import { fetchAccountList, updateAccountEntry } from "./services/integrations-api.js";
import { parseMyAnimeListApiList } from "./services/myanimelist-account.js";
import { parseAniListAccountList, type AniListScoreFormat } from "./services/anilist-account.js";
import { canAdvanceSyncBaseline, createBidirectionalSyncPlan } from "./core/bidirectional-sync.js";

import {
  createImportPreview,
  type ImportPreview,
} from "./core/import-preview.js";

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

  const [importFormat, setImportFormat] = useState("");

  const [importing, setImporting] = useState(false);
  const [metadataEnriching, setMetadataEnriching] = useState(false);
  const [metadataProgress, setMetadataProgress] = useState<MetadataEnrichmentProgress | null>(null);
  const [metadataEnrichmentError, setMetadataEnrichmentError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [integrationStatusLoading, setIntegrationStatusLoading] = useState(false);
  const [integrationStatusError, setIntegrationStatusError] = useState("");
  const [accountSyncing, setAccountSyncing] = useState<"mal" | "anilist" | null>(null);

  useEffect(() => {
    let cancelled = false;
    let openedRepository: BrowserAnimeRepository | null = null;

    async function initialize() {
      try {
        const db = await BrowserAnimeRepository.open();

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
          current.externalIds.anilist === anime.externalIds.anilist)
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
      setCatalogActionMessage(existing
        ? "Информация об аниме обновлена. Твоя запись и статус просмотра сохранены."
        : "Аниме добавлено в список «В планах».");
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : "Не удалось добавить аниме.");
    } finally {
      setAddingCatalogId(null);
    }
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
      setImportFormat(isMyAnimeListXml ? "MyAnimeList XML" : `JSON v${validated.schemaVersion}`);
      setImportAnalysis(analysis);
      setError("");
    } catch (err) {
      setImportSnapshot(null);
      setImportAnalysis(null);
      setImportFormat("");

      setError(
        err instanceof Error ? err.message : "Не удалось прочитать файл.",
      );
    } finally {
      input.value = "";
    }
  }

  async function handleImportFromAccount(provider: "mal" | "anilist") {
    if (!repository || importing) return;
    setImporting(true);
    setError("");
    try {
      const payload = await fetchAccountList(provider);
      const snapshot = provider === "mal"
        ? parseMyAnimeListApiList(payload.data)
        : parseAniListAccountList(payload.data, payload.scoreFormat as AniListScoreFormat);
      const currentLibrary = await repository.getAll();
      const analysis = createImportPreview(
        snapshot.anime,
        currentLibrary.map((item) => item.anime),
      );
      setImportSnapshot(snapshot);
      setImportFormat(provider === "mal" ? "MyAnimeList account" : "AniList account");
      setImportAnalysis(analysis);
      setSettingsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось получить список из аккаунта.");
    } finally {
      setImporting(false);
    }
  }

  async function handleSyncToAccount(provider: "mal" | "anilist") {
    if (!repository || accountSyncing) return;
    setAccountSyncing(provider);
    setIntegrationStatusError("");
    try {
      const payload = await fetchAccountList(provider);
      const remoteSnapshot = provider === "mal"
        ? parseMyAnimeListApiList(payload.data)
        : parseAniListAccountList(payload.data, payload.scoreFormat as AniListScoreFormat);

      // Reconcile unfinished journal records against the freshly fetched state.
      // This handles the case where a write reached the provider just before the app closed.
      const unfinishedOperations = await repository.getUnfinishedSyncOperations(provider);
      let recoveredOperations = 0;
      for (const operation of unfinishedOperations) {
        const actualEntry = operation.direction === "remote"
          ? (() => {
              const remoteAnime = remoteSnapshot.anime.find(
                (anime) => anime.externalIds[provider === "mal" ? "myanimelist" : "anilist"] === operation.externalId,
              );
              return remoteAnime
                ? remoteSnapshot.entries.find((entry) => entry.animeId === remoteAnime.id)
                : undefined;
            })()
          : (await repository.getSourceEntries(operation.animeId)).find(
              (entry) => entry.source === operation.entry.source,
            );
        // MAL stores integer scores from 1 to 10, so compare against its
        // normalized 0-100 representation rather than the pre-rounded target.
        const expectedScore = provider === "mal"
          ? operation.entry.score === null || operation.entry.score === 0
            ? null
            : Math.max(10, Math.min(100, Math.round(operation.entry.score / 10) * 10))
          : operation.entry.score;
        const matchesTarget = Boolean(
          actualEntry &&
          actualEntry.status === operation.entry.status &&
          actualEntry.progress === operation.entry.progress &&
          actualEntry.score === expectedScore &&
          (provider === "mal" || actualEntry.favorite === operation.entry.favorite),
        );
        if (matchesTarget) {
          await repository.updateSyncOperation(operation.id, { status: "succeeded" });
          recoveredOperations += 1;
        }
      }

      const baseItems = await repository.getAll();
      const providerSource = provider === "mal" ? "myanimelist" : "anilist";
      const localItems = await Promise.all(baseItems.map(async (item) => {
        const sourceEntries = await repository.getSourceEntries(item.anime.id);
        return {
          ...item,
          baseline: sourceEntries.find((entry) => entry.source === providerSource),
        };
      }));
      const plan = createBidirectionalSyncPlan(localItems, remoteSnapshot, provider);

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
        await repository.saveSourceEntries(baselines);
      }

      const remoteCreates = [...plan.remoteCreates];
      const remoteUpdates = [...plan.remoteUpdates];
      const localCreates = [...plan.localCreates];
      const localUpdates = [...plan.localUpdates];

      // Each conflicting anime is resolved explicitly. Cancel or S keeps it untouched.
      const conflictAnimeIds = [...new Set(plan.conflicts.map((conflict) => conflict.animeId))];
      const resolvedConflictAnimeIds = new Set<string>();
      for (const animeId of conflictAnimeIds) {
        const local = localItems.find((item) => item.anime.id === animeId);
        if (!local?.entry) continue;
        const externalId = provider === "mal"
          ? local.anime.externalIds.myanimelist
          : local.anime.externalIds.anilist;
        if (!externalId) continue;
        const remoteAnime = remoteSnapshot.anime.find((anime) =>
          (provider === "mal" ? anime.externalIds.myanimelist : anime.externalIds.anilist) === externalId
        );
        const remoteEntry = remoteAnime
          ? remoteSnapshot.entries.find((entry) => entry.animeId === remoteAnime.id)
          : undefined;
        if (!remoteEntry) continue;

        const fields = plan.conflicts
          .filter((conflict) => conflict.animeId === animeId)
          .map((conflict) => conflict.field + ": " + String(conflict.localValue) + " ↔ " + String(conflict.remoteValue))
          .join("\n");
        const choice = window.prompt(
          "Конфликт: " + (local.anime.titles.english || local.anime.titles.romaji || animeId) +
          "\n" + fields +
          "\n\nL — оставить локальную версию и отправить её на сервис" +
          "\nR — принять версию сервиса и обновить локальную библиотеку" +
          "\nS или Отмена — пропустить этот тайтл",
          "S",
        );
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
              source: provider === "mal" ? "myanimelist" : "anilist",
            },
          });
        }
      }

      const remoteChanges = remoteCreates.length + remoteUpdates.length;
      const localChanges = localCreates.length + localUpdates.length;
      if (remoteChanges === 0 && localChanges === 0) {
        const unresolved = conflictAnimeIds.filter(
          (id) => !resolvedConflictAnimeIds.has(id),
        ).length;
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
        window.alert(
          "Синхронизация завершена без изменений.\n" +
          "Без изменений: " + plan.unchanged +
          "\nВосстановлено по журналу: " + recoveredOperations +
          "\nКонфликтных полей: " + plan.conflicts.length +
          "\nПропущено записей без внешнего ID: " + plan.skippedWithoutExternalId +
          baselineMessage,
        );
        return;
      }

      const serviceName = provider === "mal" ? "MyAnimeList" : "AniList";
      const confirmed = window.confirm(
        "План синхронизации с " + serviceName + ":" +
        "\nНовые записи на сервисе: " + remoteCreates.length +
        "\nОбновления на сервисе: " + remoteUpdates.length +
        "\nНовые записи в локальной библиотеке: " + localCreates.length +
        "\nОбновления локальной библиотеки: " + localUpdates.length +
        "\nНеразрешённых конфликтных тайтлов пропущено: " +
          conflictAnimeIds.filter((id) => !resolvedConflictAnimeIds.has(id)).length +
        (unfinishedOperations.length
          ? "\nНезавершённых операций из прошлых запусков: " + unfinishedOperations.length +
            "\nУже подтверждено сверкой: " + recoveredOperations
          : "") +
        "\n\nПеред изменениями будет скачана резервная копия. Продолжить?"
      );
      if (!confirmed) return;

      // Backup is created before the first write to either side.
      downloadSnapshot(await repository.snapshot());

      const sessionId = `sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
      ];
      const remoteJournalOperations: SyncOperation[] = remoteChangesToApply.map((change, index) => {
        const localMatch = localItems.find(
          (item) => item.anime.externalIds[providerSource] === change.externalId,
        );
        return {
          id: `${sessionId}-remote-${index}`,
          sessionId,
          provider,
          direction: "remote",
          kind: index < remoteCreates.length ? "create" : "update",
          animeId: localMatch?.anime.id ?? change.entry.animeId,
          externalId: change.externalId,
          entry: structuredClone(change.entry),
          status: "pending",
          attempts: 0,
          createdAt: journalCreatedAt,
          updatedAt: journalCreatedAt,
        };
      });
      const localJournalOperations: SyncOperation[] = localChangesToApply.map((change, index) => ({
        id: `${sessionId}-local-${index}`,
        sessionId,
        provider,
        direction: "local",
        kind: change.kind,
        animeId: change.animeId,
        entry: structuredClone(change.entry),
        ...(change.kind === "create" ? { anime: structuredClone(change.anime) } : {}),
        status: "pending",
        attempts: 0,
        createdAt: journalCreatedAt,
        updatedAt: journalCreatedAt,
      }));
      // The entire plan is durable before the first write starts.
      await repository.saveSyncOperations([
        ...remoteJournalOperations,
        ...localJournalOperations,
      ]);

      let remoteSucceeded = 0;
      let localSucceeded = 0;
      const failures: string[] = [];

      for (let index = 0; index < remoteChangesToApply.length; index += 1) {
        const change = remoteChangesToApply[index]!;
        const operation = remoteJournalOperations[index]!;
        await repository.updateSyncOperation(operation.id, {
          status: "in_progress",
          attempts: operation.attempts + 1,
        });
        try {
          await updateAccountEntry(provider, {
            externalId: change.externalId,
            status: change.entry.status,
            progress: change.entry.progress,
            score: change.entry.score,
            ...(provider === "anilist" ? { favorite: change.entry.favorite } : {}),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "ошибка записи";
          await repository.updateSyncOperation(operation.id, {
            status: "failed",
            error: message,
          });
          failures.push("ID " + change.externalId + " (" + message + ")");
          continue;
        }
        // If this journal update itself fails, the operation remains in_progress.
        // The next run will verify the provider state before deciding what happened.
        await repository.updateSyncOperation(operation.id, { status: "succeeded" });
        remoteSucceeded += 1;
      }

      for (let index = 0; index < localChangesToApply.length; index += 1) {
        const change = localChangesToApply[index]!;
        const operation = localJournalOperations[index]!;
        await repository.updateSyncOperation(operation.id, {
          status: "in_progress",
          attempts: operation.attempts + 1,
        });
        try {
          if (change.kind === "create") {
            await repository.saveAnimeWithEntry(change.anime, change.entry);
          } else {
            await repository.saveEntry(change.entry);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "ошибка";
          await repository.updateSyncOperation(operation.id, {
            status: "failed",
            error: message,
          });
          failures.push(
            change.animeId +
            (change.kind === "create" ? " (локальное добавление: " : " (локальное обновление: ") +
            message + ")",
          );
          continue;
        }
        await repository.updateSyncOperation(operation.id, { status: "succeeded" });
        localSucceeded += 1;
      }

      // A baseline is only safe when every planned write succeeded and no
      // conflict was intentionally skipped. Otherwise the next sync must
      // compare against the previous common state and retry/reconcile safely.
      const unresolvedConflictCount = conflictAnimeIds.filter(
        (id) => !resolvedConflictAnimeIds.has(id),
      ).length;
      const warnings: string[] = [];

      if (canAdvanceSyncBaseline(failures.length, unresolvedConflictCount)) {
        // Refresh the provider snapshot and persist it as the next three-way merge baseline.
        try {
          const refreshedPayload = await fetchAccountList(provider);
          const refreshedSnapshot = provider === "mal"
            ? parseMyAnimeListApiList(refreshedPayload.data)
            : parseAniListAccountList(refreshedPayload.data, refreshedPayload.scoreFormat as AniListScoreFormat);
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
      window.alert(
        "Двусторонняя синхронизация с " + serviceName + " завершена." +
        "\nУспешно записано на сервис: " + remoteSucceeded +
        "\nУспешно обновлено локально: " + localSucceeded +
        "\nБез изменений: " + plan.unchanged +
        "\nКонфликтных полей: " + plan.conflicts.length +
        "\nВосстановлено по журналу: " + recoveredOperations +
        "\nОшибок: " + failures.length +
        (failures.length ? "\n" + failures.slice(0, 8).join("\n") : "") +
        (warnings.length ? "\n" + warnings.join("\n") : "") +
        "\n\nРезервная копия скачана."
      );
    } catch (err) {
      setIntegrationStatusError(err instanceof Error ? err.message : "Не удалось выполнить двустороннюю синхронизацию.");
    } finally {
      setAccountSyncing(null);
    }
  }

  async function handleConfirmImport() {
    if (!repository || !importSnapshot || importing) return;

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

      for (const item of freshAnalysis.items) {
        const match = item.matchedAnime;
        if (!match || match.id === item.imported.id) continue;

        if (mappedTargets.has(match.id)) {
          throw new Error(
            `Несколько импортируемых записей указывают на один и тот же тайтл в библиотеке: ${match.titles.english ?? match.titles.romaji ?? match.id}.`,
          );
        }

        mappedTargets.add(match.id);
        mappings[item.imported.id] = match.id;
      }

      // Автоматически создаём резервную копию перед безопасным добавлением/слиянием.
      const backup = await repository.snapshot();
      downloadSnapshot(backup);

      await repository.mergeSnapshotWithMappings(importSnapshot, mappings);
      await refreshLibrary();

      const importedCount = freshAnalysis.summary.new;
      const matchedCount = freshAnalysis.summary.matched;

      setImportSnapshot(null);
      setImportAnalysis(null);
      setImportFormat("");

      window.alert(
        `Импорт завершён! Новых тайтлов добавлено: ${importedCount}. Точных совпадений объединено: ${matchedCount}. Резервная копия скачана.`,
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

    const confirmed = window.confirm("Удалить это аниме из библиотеки?");

    if (!confirmed) return;

    try {
      await repository.deleteAnime(id);
      await refreshLibrary();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось удалить аниме.",
      );
    }
  }


  const filteredLibrary = useMemo(
    () => filterLibrary(library, filters).sort((a, b) => {
      const titleA = a.anime.titles.english ?? a.anime.titles.romaji ?? "";
      const titleB = b.anime.titles.english ?? b.anime.titles.romaji ?? "";
      return titleA.localeCompare(titleB);
    }),
    [library, filters],
  );

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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">M</div>
          <div>
            <h2>MidaHoshi</h2>
            <span>ANIME SYNC</span>
          </div>
        </div>

        <div className="menu-label">МЕНЮ</div>

        <nav className="navigation">
          <button className="nav-item active">
            ▦ <span>Главная</span>
          </button>
          <button className="nav-item" onClick={() => setFilters((current) => ({ ...current, status: "ALL" }))}>
            ▤ <span>Моя библиотека</span>
          </button>
          <button className={"nav-item " + (settingsOpen ? "active" : "")} onClick={() => setSettingsOpen((value) => !value)}>
            ⇄ <span>Подключения</span>
          </button>
          <button className="nav-item" disabled>
            ◷ <span>История</span>
          </button>
        </nav>

        <div className="menu-label services-label">СЕРВИСЫ</div>

        <nav className="navigation">
          {["MyAnimeList", "AniList", "Shikimori", "Другие сервисы"].map(
            (service) => (
              <button className="nav-item" key={service} disabled>
                ◉ <span>{service}</span>
                <i />
              </button>
            ),
          )}
        </nav>

        <div className="sidebar-bottom">
          <button className={"nav-item " + (settingsOpen ? "active" : "")} onClick={() => setSettingsOpen((value) => !value)}>
            ⚙ <span>Настройки</span>
          </button>
          <div className="version">MidaHoshi Anime Sync v0.4</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Рабочее пространство <span>/</span> Главная
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
          {settingsOpen && (
            <section className="integration-settings">
              <div className="section-heading">
                <div>
                  <div className="eyebrow">ACCOUNT CONNECTIONS</div>
                  <h2>Подключение аккаунтов</h2>
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
              {(["myanimelist", "anilist"] as const).map((provider) => {
                const label = provider === "myanimelist" ? "MyAnimeList" : "AniList";
                const status = integrationStatus?.[provider];
                const routeProvider = provider === "myanimelist" ? "mal" : "anilist";
                return (
                  <article className="integration-provider" key={provider}>
                    <div className="integration-provider-mark">{provider === "myanimelist" ? "MAL" : "AL"}</div>
                    <div className="integration-provider-info">
                      <h3>{label}</h3>
                      <p>
                        {integrationStatusLoading && !status
                          ? "Проверяем подключение..."
                          : !integrationStatus
                            ? "Локальный API-сервер не отвечает."
                            : !status?.configured
                              ? (routeProvider === "anilist" ? "Нужно добавить Client ID и Client Secret в .env.local." : "Нужно добавить Client ID в .env.local.")
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
              <div className="integration-security-note">
                <strong>Безопасность:</strong> токены сохраняются локально в зашифрованном виде. Не публикуй .env.local и папку .local-data.
              </div>
            </section>
          )}
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

          {importSnapshot && importAnalysis && (
            <section className="import-preview">
              <div className="import-preview-heading">
                <div>
                  <div className="eyebrow">IMPORT CENTER</div>
                  <h2>Предварительный просмотр импорта</h2>
                  <p>
                    Новые тайтлы будут добавлены автоматически. Совпадения определяются только по точным ID, а похожие названия не объединяются.
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
                  <strong>{importAnalysis.summary.new}</strong>
                </div>

                <div className="import-summary-card matched">
                  <span>Совпадения</span>
                  <strong>{importAnalysis.summary.matched}</strong>
                </div>

              </div>

              <div className="import-file-info">
                <span>Формат: {importFormat || `JSON v${importSnapshot.schemaVersion}`}</span>
                <span>Записей библиотеки: {importSnapshot.entries.length}</span>
              </div>

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
                  disabled={importing}
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
                  const progress = entry?.progress ?? 0;

                  const percent =
                    typeof totalEpisodes === "number" && totalEpisodes > 0
                      ? Math.min(
                          100,
                          Math.round((progress / totalEpisodes) * 100),
                        )
                      : 0;

                  return (
                    <article className="anime-card" key={anime.id}>
                      <AnimeCover url={anime.posterUrl ?? null} score={anime.averageScore ?? null} />

                      <div className="anime-details">
                        <h3>{title}</h3>
                        <p className="anime-subtitle">{anime.titles.romaji ?? " "}</p>
                        <div className="anime-catalog-meta">{anime.format ?? "Формат не указан"}{anime.year ? ` · ${anime.year}` : ""}{anime.genres?.length ? ` · ${anime.genres.join(", ")}` : ""}</div>

                        {entry && (
                          <>
                            <div className="anime-meta">
                              <span className="status-label">
                                {statusLabels[entry.status]}
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
                                {typeof totalEpisodes === "number" &&
                                totalEpisodes > 0
                                  ? `Эпизод ${progress} из ${totalEpisodes}`
                                  : `Просмотрено ${progress} эпизодов`}
                              </span>

                              <span>
                                {typeof totalEpisodes === "number" &&
                                totalEpisodes > 0
                                  ? `${percent}%`
                                  : ""}
                              </span>
                            </div>

                            {typeof totalEpisodes === "number" &&
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
            <span>MidaHoshi Anime Sync</span>
            <span>Твоя библиотека. Твои правила.</span>
          </footer>
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
                          {addingCatalogId === anime.id ? "Сохраняем..." : existing?.entry ? "Обновить данные" : existing ? "Добавить в список" : "＋ Добавить в библиотеку"}
                        </button>
                      </div>
                    </article>;
                  })}
              </div>
            )}
          </div>
        </div>
      )}
\n      {searchPageOpen && selectedAnime && (
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
