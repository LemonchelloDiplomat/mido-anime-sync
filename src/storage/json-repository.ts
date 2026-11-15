import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshot,
  AnimeSourceEntry,
} from "../core/types.js";

import { validateSnapshot, validateEntry } from "./snapshot-validation.js";

export class JsonAnimeRepository {
  private anime = new Map<string, AnimeIdentity>();

  // Общая библиотека.
  private entries = new Map<string, AnimeListEntry>();

  // Отдельные записи каждого источника.
  private sourceEntries = new Map<string, AnimeSourceEntry>();

  private getSourceKey(entry: AnimeSourceEntry): string {
    return `${entry.animeId}:${entry.source}`;
  }

  async load(path: string): Promise<void> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const snapshot = validateSnapshot(parsed);

      this.anime = new Map(snapshot.anime.map((item) => [item.id, item]));

      this.entries = new Map(
        snapshot.entries.map((item) => [item.animeId, item]),
      );

      this.sourceEntries = new Map(
        snapshot.sourceEntries.map((item) => [this.getSourceKey(item), item]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  saveAnime(anime: AnimeIdentity): void {
    this.anime.set(anime.id, structuredClone(anime));
  }

  saveEntry(entry: AnimeListEntry): void {
    validateEntry(entry);

    if (!this.anime.has(entry.animeId)) {
      throw new Error(`Unknown animeId: ${entry.animeId}`);
    }

    const copy = structuredClone(entry);

    this.entries.set(entry.animeId, copy);

    this.sourceEntries.set(this.getSourceKey(copy), structuredClone(copy));
  }

  getAnime(id: string): AnimeIdentity | undefined {
    const value = this.anime.get(id);

    return value ? structuredClone(value) : undefined;
  }

  getEntry(animeId: string): AnimeListEntry | undefined {
    const value = this.entries.get(animeId);

    return value ? structuredClone(value) : undefined;
  }

  snapshot(): AnimeSnapshot {
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),

      anime: [...this.anime.values()].map((item) => structuredClone(item)),

      entries: [...this.entries.values()].map((item) => structuredClone(item)),

      sourceEntries: [...this.sourceEntries.values()].map((item) =>
        structuredClone(item),
      ),
    };
  }

  async exportTo(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });

    await writeFile(path, JSON.stringify(this.snapshot(), null, 2), "utf8");
  }

  async importFrom(path: string): Promise<void> {
    const raw = await readFile(path, "utf8");

    const snapshot = validateSnapshot(JSON.parse(raw) as unknown);

    this.anime = new Map(snapshot.anime.map((item) => [item.id, item]));

    this.entries = new Map(
      snapshot.entries.map((item) => [item.animeId, item]),
    );

    this.sourceEntries = new Map(
      snapshot.sourceEntries.map((item) => [this.getSourceKey(item), item]),
    );
  }
}
