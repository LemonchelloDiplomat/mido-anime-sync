import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonAnimeRepository } from "../src/storage/json-repository.js";

let dir = "";
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });

describe("JSON repository", () => {
  it("saves and exports a library snapshot", async () => {
    dir = await mkdtemp(join(tmpdir(), "anime-sync-"));
    const repo = new JsonAnimeRepository();
    repo.saveAnime({
      id: "anime-1",
      titles: { english: "Example Anime", synonyms: [] },
      externalIds: {},
      episodes: 12
    });
    repo.saveEntry({
      animeId: "anime-1", status: "WATCHING", progress: 3,
      score: 85, favorite: true, updatedAt: "2026-11-15T00:00:00.000Z",
      source: "local"
    });
    const path = join(dir, "backup.json");
    await repo.exportTo(path);
    const restored = new JsonAnimeRepository();
    await restored.importFrom(path);
    expect(restored.getEntry("anime-1")?.progress).toBe(3);
    expect(restored.getAnime("anime-1")?.titles.english).toBe("Example Anime");
  });

  it("rejects entries without an anime record", () => {
    const repo = new JsonAnimeRepository();
    expect(() => repo.saveEntry({
      animeId: "missing", status: "PLANNING", progress: 0, score: null,
      favorite: false, updatedAt: new Date().toISOString(), source: "local"
    })).toThrow(/Unknown animeId/);
  });
});
