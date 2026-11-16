import { describe, expect, it } from "vitest";
import { parseMyAnimeListXml, readMyAnimeListExport } from "../src/services/myanimelist-import.js";

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<myanimelist>
  <myinfo><user_name>test_user</user_name></myinfo>
  <anime>
    <series_animedb_id>52991</series_animedb_id>
    <series_title>Sousou no Frieren</series_title>
    <series_title_english>Frieren: Beyond Journey's End</series_title_english>
    <series_title_japanese>葬送のフリーレン</series_title_japanese>
    <series_synonyms>Frieren; Frieren at the Funeral</series_synonyms>
    <series_type>1</series_type>
    <series_episodes>28</series_episodes>
    <series_start>2023-09-29</series_start>
    <series_score>9</series_score>
    <series_image>https://example.com/frieren.jpg</series_image>
    <my_status>1</my_status>
    <my_score>10</my_score>
    <my_watched_episodes>12</my_watched_episodes>
    <my_times_watched>0</my_times_watched>
    <my_start_date>2026-01-01</my_start_date>
    <my_finish_date>0000-00-00</my_finish_date>
    <my_last_updated>1760000000</my_last_updated>
    <my_tags>fantasy; favourite</my_tags>
  </anime>
  <anime>
    <series_animedb_id>1</series_animedb_id>
    <series_title>Cowboy Bebop</series_title>
    <series_type>1</series_type>
    <series_episodes>26</series_episodes>
    <series_score>8</series_score>
    <my_status>2</my_status>
    <my_score>0</my_score>
    <my_watched_episodes>26</my_watched_episodes>
  </anime>
</myanimelist>`;

describe("MyAnimeList XML importer", () => {
  it("maps titles, IDs, metadata and personal list values", () => {
    const snapshot = parseMyAnimeListXml(sample, "2026-11-16T00:00:00.000Z");

    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.anime).toHaveLength(2);
    expect(snapshot.anime[0]).toMatchObject({
      id: "mal:52991",
      titles: {
        english: "Frieren: Beyond Journey's End",
        romaji: "Sousou no Frieren",
        native: "葬送のフリーレン",
        synonyms: ["Frieren", "Frieren at the Funeral"],
      },
      externalIds: { myanimelist: "52991" },
      year: 2023,
      format: "TV",
      episodes: 28,
      averageScore: 9,
      posterUrl: "https://example.com/frieren.jpg",
    });
    expect(snapshot.entries[0]).toMatchObject({
      animeId: "mal:52991",
      status: "WATCHING",
      progress: 12,
      score: 100,
      source: "myanimelist",
      sourceMetadata: {
        originalStatus: "1",
        originalScore: "10",
        timesWatched: 0,
        startDate: "2026-01-01",
        tags: "fantasy; favourite",
      },
    });
    expect(snapshot.entries[1]).toMatchObject({
      status: "COMPLETED",
      progress: 26,
      score: null,
    });
    expect(snapshot.sourceEntries).toEqual(snapshot.entries);
  });

  it("maps all MAL list statuses", () => {
    const statuses = [
      ["1", "WATCHING"],
      ["2", "COMPLETED"],
      ["3", "ON_HOLD"],
      ["4", "DROPPED"],
      ["6", "PLANNING"],
    ] as const;

    for (const [raw, expected] of statuses) {
      const xml = `<myanimelist><anime>
        <series_animedb_id>123</series_animedb_id>
        <series_title>Example</series_title>
        <my_status>${raw}</my_status>
      </anime></myanimelist>`;
      expect(parseMyAnimeListXml(xml).entries[0]?.status).toBe(expected);
    }
  });

  it("rejects non-MAL XML, malformed records and unsupported statuses", () => {
    expect(() => parseMyAnimeListXml("<root></root>")).toThrow(/не похоже/);
    expect(() => parseMyAnimeListXml(
      "<myanimelist><anime><series_animedb_id>1</series_animedb_id></anime></myanimelist>",
    )).toThrow(/отсутствует ID или название/);
    expect(() => parseMyAnimeListXml(
      "<myanimelist><anime><series_animedb_id>1</series_animedb_id><series_title>X</series_title><my_status>unknown</my_status></anime></myanimelist>",
    )).toThrow(/неизвестный статус/);
  });

  it("rejects DTD declarations and duplicate IDs", () => {
    expect(() => parseMyAnimeListXml(
      "<!DOCTYPE myanimelist [<!ENTITY x 'x'>]><myanimelist></myanimelist>",
    )).toThrow(/DTD/);
    expect(() => parseMyAnimeListXml(
      "<myanimelist><anime><series_animedb_id>1</series_animedb_id><series_title>A</series_title><my_status>1</my_status></anime><anime><series_animedb_id>1</series_animedb_id><series_title>B</series_title><my_status>2</my_status></anime></myanimelist>",
    )).toThrow(/повторяется ID/);
  });
});

describe("MyAnimeList export file reader", () => {
  it("reads the default gzip-compressed XML export without manual extraction", async () => {
    const compressedStream = new Blob([sample]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressedBlob = await new Response(compressedStream).blob();
    const file = Object.assign(compressedBlob, { name: "animelist_test.xml.gz" });

    await expect(readMyAnimeListExport(file)).resolves.toBe(sample);
  });

  it("reads plain XML files unchanged", async () => {
    const file = Object.assign(new Blob([sample]), { name: "animelist_test.xml" });
    await expect(readMyAnimeListExport(file)).resolves.toBe(sample);
  });
});
