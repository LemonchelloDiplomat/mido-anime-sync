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
} from "./core/types.js";

import { BrowserAnimeRepository } from "./storage/browser-repository.js";
import { validateSnapshot } from "./storage/snapshot-validation.js";
import { DEFAULT_LIBRARY_FILTERS, filterLibrary, type LibraryFilters } from "./core/library-filter.js";

import {
  createImportPreview,
  type ImportPreview,
} from "./core/import-preview.js";

type LibraryItem = {
  anime: AnimeIdentity;
  entry: AnimeListEntry | undefined;
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

const KEEP_SEPARATE = "__KEEP_SEPARATE__";

type ImportSelections = Record<string, string>;

function createInitialImportSelections(
  analysis: ImportPreview,
): ImportSelections {
  return Object.fromEntries(
    analysis.items.map((item) => {
      if (item.status === "new") {
        return [item.imported.id, KEEP_SEPARATE];
      }

      if (item.status === "matched") {
        return [item.imported.id, item.selectedMatch?.id ?? item.imported.id];
      }

      return [item.imported.id, ""];
    }),
  );
}

const statusLabels: Record<AnimeStatus, string> = {
  PLANNING: "В планах",
  WATCHING: "Смотрю",
  COMPLETED: "Просмотрено",
  ON_HOLD: "Отложено",
  DROPPED: "Брошено",
  REWATCHING: "Пересматриваю",
};

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

  const [importSelections, setImportSelections] = useState<ImportSelections>(
    {},
  );

  const [importing, setImporting] = useState(false);

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

  async function refreshLibrary() {
    if (!repository) return;
    setLibrary(await repository.getAll());
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

      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const validated = validateSnapshot(parsed);

      const analysis = createImportPreview(
        validated.anime,
        library.map((item) => item.anime),
      );

      setImportSnapshot(validated);
      setImportAnalysis(analysis);
      setImportSelections(createInitialImportSelections(analysis));
      setError("");
    } catch (err) {
      setImportSnapshot(null);
      setImportAnalysis(null);
      setImportSelections({});

      setError(
        err instanceof Error ? err.message : "Не удалось прочитать файл.",
      );
    } finally {
      input.value = "";
    }
  }

  async function handleConfirmImport() {
    if (!repository || !importSnapshot || importing) return;

    setImporting(true);
    setError("");

    try {
      const currentLibrary = await repository.getAll();
      const currentIds = new Set(currentLibrary.map((item) => item.anime.id));

      const freshAnalysis = createImportPreview(
        importSnapshot.anime,
        currentLibrary.map((item) => item.anime),
      );

      setImportAnalysis(freshAnalysis);

      const mappings: Record<string, string> = {};
      const targetOwners = new Map<string, string>();

      for (const item of freshAnalysis.items) {
        if (item.duplicateInImport) {
          throw new Error(
            `Импорт заблокирован: обнаружен дубликат внутри файла (${
              item.imported.titles.english ??
              item.imported.titles.romaji ??
              item.imported.id
            }).`,
          );
        }

        const importedId = item.imported.id;
        const selected = importSelections[importedId] ?? "";

        if (!selected) {
          throw new Error(
            `Не выбрано соответствие для аниме: ${
              item.imported.titles.english ??
              item.imported.titles.romaji ??
              importedId
            }`,
          );
        }

        if (selected === KEEP_SEPARATE) {
          if (currentIds.has(importedId)) {
            throw new Error(
              `Нельзя оставить отдельной записью аниме с уже существующим ID: ${importedId}`,
            );
          }

          continue;
        }

        if (!currentIds.has(selected)) {
          throw new Error(
            `Выбранная запись больше не существует в библиотеке: ${selected}`,
          );
        }

        const isSameId = selected === importedId;

        const isAvailableMatch =
          isSameId || item.matches.some((match) => match.anime.id === selected);

        if (!isAvailableMatch) {
          throw new Error(
            `Выбранное соответствие больше не подтверждается: ${importedId}`,
          );
        }

        const previousOwner = targetOwners.get(selected);

        if (previousOwner && previousOwner !== importedId) {
          throw new Error(
            `Несколько импортируемых аниме выбраны для одной записи: ${selected}`,
          );
        }

        targetOwners.set(selected, importedId);

        if (!isSameId) {
          mappings[importedId] = selected;
        }
      }

      const confirmed = window.confirm(
        `Объединить ${importSnapshot.anime.length} аниме и ${importSnapshot.entries.length} записей с текущей библиотекой? Новые тайтлы будут добавлены, выбранные совпадения объединены. Отсутствующие в файле тайтлы сохранятся. Перед этим будет скачана резервная копия.`,
      );

      if (!confirmed) return;

      const backup = await repository.snapshot();

      downloadSnapshot(backup);

      await repository.mergeSnapshotWithMappings(importSnapshot, mappings);

      await refreshLibrary();

      setImportSnapshot(null);
      setImportAnalysis(null);
      setImportSelections({});

      window.alert("Слияние библиотек завершено! Резервная копия скачана.");
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

  const importSelectionValidation = useMemo(() => {
    if (!importAnalysis) {
      return {
        valid: false,
        mappings: {} as Record<string, string>,
        unresolved: 0,
        duplicateTargets: [] as string[],
        duplicateImports: 0,
      };
    }

    const existingIds = new Set(library.map((item) => item.anime.id));
    const mappings: Record<string, string> = {};
    const targetOwners = new Map<string, string>();
    const duplicateTargets = new Set<string>();

    let unresolved = 0;
    let duplicateImports = 0;

    for (const item of importAnalysis.items) {
      if (item.duplicateInImport) {
        duplicateImports++;
        continue;
      }

      const importedId = item.imported.id;
      const selected = importSelections[importedId] ?? "";

      if (!selected) {
        unresolved++;
        continue;
      }

      if (selected === KEEP_SEPARATE) {
        if (existingIds.has(importedId)) {
          unresolved++;
        }

        continue;
      }

      if (!existingIds.has(selected)) {
        unresolved++;
        continue;
      }

      const isSameId = selected === importedId;

      const isAvailableMatch =
        isSameId || item.matches.some((match) => match.anime.id === selected);

      if (!isAvailableMatch) {
        unresolved++;
        continue;
      }

      const previousOwner = targetOwners.get(selected);

      if (previousOwner && previousOwner !== importedId) {
        duplicateTargets.add(selected);
      } else {
        targetOwners.set(selected, importedId);
      }

      if (!isSameId) {
        mappings[importedId] = selected;
      }
    }

    return {
      valid:
        unresolved === 0 &&
        duplicateTargets.size === 0 &&
        duplicateImports === 0,
      mappings,
      unresolved,
      duplicateTargets: [...duplicateTargets],
      duplicateImports,
    };
  }, [importAnalysis, importSelections, library]);

  const canConfirmImport = importSelectionValidation.valid;

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
          <button className="nav-item" disabled>
            ⇄ <span>Синхронизация</span>
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
          <button className="nav-item" disabled>
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
          <button className="search-launch" onClick={() => setSearchPageOpen(true)} aria-label="Открыть поиск" title="Поиск">⌕</button>
          <div className="profile">
            <div className="avatar">M</div>
            <span>Моя библиотека</span>
          </div>
        </header>

        <div className="content">
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
              <p>Подключение внешних сервисов появится на следующем этапе.</p>
            </div>
            <div className="sync-status">
              <span className="status-dot" />
              Локальная библиотека
            </div>
            <button className="secondary-button" disabled>
              Скоро →
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
              ↑ Импорт JSON
              <input
                type="file"
                accept=".json,application/json"
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
                    Проверь результаты сопоставления перед изменением
                    библиотеки.
                  </p>
                </div>

                <button
                  className="small-action"
                  onClick={() => {
                    setImportSnapshot(null);
                    setImportAnalysis(null);
                    setImportSelections({});
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

                <div className="import-summary-card review">
                  <span>Проверить</span>
                  <strong>{importAnalysis.summary.review}</strong>
                </div>
              </div>

              <div className="import-file-info">
                <span>Формат: JSON v{importSnapshot.schemaVersion}</span>
                <span>Записей библиотеки: {importSnapshot.entries.length}</span>
              </div>

              <div className="import-results">
                {importAnalysis.items.map((item, index) => {
                  const title =
                    item.imported.titles.english ??
                    item.imported.titles.romaji ??
                    item.imported.titles.native ??
                    "Без названия";

                  const statusLabel = {
                    new: "Новый",
                    matched: "Совпадение",
                    review: "Проверить",
                  }[item.status];

                  const matchedTitle = item.selectedMatch
                    ? (item.selectedMatch.titles.english ??
                      item.selectedMatch.titles.romaji ??
                      item.selectedMatch.titles.native ??
                      "Без названия")
                    : null;

                  return (
                    <article
                      className="import-result-item"
                      key={`${item.imported.id}-${index}`}
                    >
                      <div className="import-result-main">
                        <strong>{title}</strong>
                        <span>{item.reason}</span>

                        {item.duplicateInImport && (
                          <strong className="import-duplicate-warning">
                            ⚠ Эта запись заблокирована из-за возможного
                            дубликата внутри файла.
                          </strong>
                        )}

                        {item.matches.length > 0 && (
                          <div className="import-match-list">
                            {item.matches.map((match) => (
                              <div
                                className="import-match"
                                key={match.anime.id}
                              >
                                <span>
                                  Возможное совпадение:{" "}
                                  {match.anime.titles.english ??
                                    match.anime.titles.romaji ??
                                    match.anime.titles.native ??
                                    "Без названия"}
                                </span>

                                <span>{match.score}/100</span>

                                <small>{match.reasons.join(" · ")}</small>
                              </div>
                            ))}
                          </div>
                        )}

                        {!item.duplicateInImport &&
                          (item.status === "review" ||
                            item.matches.length > 0 ||
                            (item.selectedMatch !== null &&
                              item.selectedMatch.id !== item.imported.id)) && (
                            <label className="import-selection-control">
                              <span>Как поступить с этой записью?</span>

                              <select
                                className="filter-select"
                                value={importSelections[item.imported.id] ?? ""}
                                onChange={(event) =>
                                  setImportSelections((previous) => ({
                                    ...previous,
                                    [item.imported.id]: event.target.value,
                                  }))
                                }
                                disabled={importing}
                              >
                                <option value="">Выбери действие...</option>

                                {!library.some(
                                  (existing) =>
                                    existing.anime.id === item.imported.id,
                                ) && (
                                  <option value={KEEP_SEPARATE}>
                                    Оставить отдельным аниме
                                  </option>
                                )}

                                {item.matches.map((match) => {
                                  const matchTitle =
                                    match.anime.titles.english ??
                                    match.anime.titles.romaji ??
                                    match.anime.titles.native ??
                                    "Без названия";

                                  return (
                                    <option
                                      value={match.anime.id}
                                      key={match.anime.id}
                                    >
                                      Объединить с: {matchTitle} ({match.score}
                                      /100)
                                    </option>
                                  );
                                })}

                                {item.selectedMatch &&
                                  item.selectedMatch.id ===
                                    item.imported.id && (
                                    <option value={item.imported.id}>
                                      Использовать существующую запись
                                    </option>
                                  )}
                              </select>
                            </label>
                          )}

                        {matchedTitle && (
                          <small className="import-selected-match">
                            Автоматически найдено: {matchedTitle}
                          </small>
                        )}
                      </div>

                      <span className={`import-status ${item.status}`}>
                        {statusLabel}
                      </span>
                    </article>
                  );
                })}
              </div>

              <div className="import-safety-note">
                {canConfirmImport ? (
                  <>
                    <strong>Можно продолжить.</strong>
                    <p>
                      Все соответствия проверены. Новые тайтлы будут добавлены,
                      выбранные совпадения объединены, остальные записи
                      сохранены.
                    </p>
                  </>
                ) : (
                  <>
                    <strong>Импорт пока заблокирован.</strong>
                    <p>
                      Осталось разрешить неоднозначные совпадения:
                      {` ${importSelectionValidation.unresolved}`}.
                      {importSelectionValidation.duplicateTargets.length > 0 &&
                        " Несколько аниме выбраны для одной существующей записи."}
                      {importSelectionValidation.duplicateImports > 0 &&
                        ` Обнаружено дубликатов внутри файла: ${importSelectionValidation.duplicateImports}. Удали или исправь их в исходном JSON и загрузи файл заново.`}
                    </p>
                  </>
                )}
              </div>

              <div className="import-actions">
                <button
                  className="secondary-button"
                  onClick={() => {
                    setImportSnapshot(null);
                    setImportAnalysis(null);
                    setImportSelections({});
                  }}
                  disabled={importing}
                >
                  Отмена
                </button>

                <button
                  className="add-button"
                  onClick={() => void handleConfirmImport()}
                  disabled={importing || !canConfirmImport}
                >
                  {importing ? "Импорт..." : "Подтвердить слияние"}
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
                      <div className="anime-cover purple">
                        {anime.posterUrl ? <img src={anime.posterUrl} alt="" loading="lazy" /> : <><span>✦</span><small>ANIME</small></>}
                        {anime.averageScore != null && <span className={`poster-score ${anime.averageScore >= 8 ? "excellent" : anime.averageScore >= 7 ? "good" : anime.averageScore >= 5 ? "average" : "poor"}`}>{anime.averageScore.toFixed(1)}</span>}
                      </div>

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
            <button className="modal-close" onClick={() => setSearchPageOpen(false)} aria-label="Назад">←</button>
            <h1>Поиск</h1>
          </header>
          <div className="search-page-content">
            <input autoFocus className="search-input" type="search" aria-label="Поиск по моей библиотеке" placeholder="Аниме" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            <div className="search-results-heading"><h2>Аниме в моей библиотеке</h2><span>{searchResults.length}</span></div>
            {searchResults.length === 0 ? <div className="empty-state"><div className="empty-icon">⌕</div><h3>Ничего не найдено</h3><p>Попробуй изменить поисковый запрос.</p></div> : <div className="search-results-list">
              {searchResults.map(({ anime, entry }) => <article className="search-result-card" key={anime.id}>
                <div className="search-result-poster">{anime.posterUrl ? <img src={anime.posterUrl} alt="" loading="lazy" /> : <span>✦</span>}{anime.averageScore != null && <b className={`poster-score ${anime.averageScore >= 8 ? "excellent" : anime.averageScore >= 7 ? "good" : anime.averageScore >= 5 ? "average" : "poor"}`}>{anime.averageScore.toFixed(1)}</b>}</div>
                <div className="search-result-details"><h3>{anime.titles.english ?? anime.titles.romaji ?? anime.titles.native ?? "Без названия"}</h3><p>{anime.titles.romaji ?? anime.titles.native ?? ""}</p><div>{anime.format ?? "Формат не указан"}{anime.year ? ` · ${anime.year}` : ""}</div><small>{(anime.genres ?? []).join(" · ") || "Жанры пока не добавлены"}</small>{entry && <span className="status-label">{statusLabels[entry.status]}</span>}</div>
              </article>)}
            </div>}
          </div>
        </div>
      )}
\n      {modalOpen && (
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
