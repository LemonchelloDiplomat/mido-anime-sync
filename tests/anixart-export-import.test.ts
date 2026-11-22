import { describe, expect, it } from "vitest";
import { parseAnixartBookmarkExport } from "../src/services/anixart-export-import.js";

describe("Anixart official bookmark export import", () => {
  it("parses a semicolon CSV with Russian headers, statuses, personal scores and exact IDs", () => {
    const result = parseAnixartBookmarkExport(
      'ID;Название;Оригинальное название;Статус просмотра;Моя оценка;Избранное\n' +
      '123;Тестовое аниме;Test Anime;Смотрю;4 из 5;Да\n' +
      '456;Второе аниме;Second Anime;Просмотрено;Не оценено;Нет',
      "anixart.csv",
      "2026-11-23T12:00:00.000Z",
    );
    expect(result.snapshot.anime).toHaveLength(2);
    expect(result.snapshot.anime[0]).toMatchObject({ id: "anixart:123", externalIds: { anixart: "123" } });
    expect(result.snapshot.sourceEntries[0]).toMatchObject({ status: "WATCHING", score: 80, favorite: true });
    expect(result.snapshot.sourceEntries[1]).toMatchObject({ status: "COMPLETED", score: null, favorite: false });
  });

  it("parses quoted commas and alternative titles without splitting the field", () => {
    const result = parseAnixartBookmarkExport(
      'Title,Original title,Alternative titles,Watch status,My score\n' +
      '"Title, with comma",Original,"Alias A; Alias B",Watching,5/5',
      "anixart.csv",
    );
    expect(result.snapshot.anime[0]?.titles.romaji).toBe("Title, with comma");
    expect(result.snapshot.anime[0]?.titles.synonyms).toEqual(["Original", "Alias A", "Alias B"]);
    expect(result.snapshot.sourceEntries[0]?.score).toBe(100);
  });

  it("supports the legacy text export layout and maps its status and score", () => {
    const result = parseAnixartBookmarkExport(
      '/"Текстовый тайтл"/"Original"/2020/12/Просмотрено/5 из 5',
      "anixart.txt",
    );
    expect(result.snapshot.anime[0]?.titles.romaji).toBe("Текстовый тайтл");
    expect(result.snapshot.sourceEntries[0]).toMatchObject({ status: "COMPLETED", score: 100 });
  });

  it("accepts a tab-delimited TXT export with headers", () => {
    const result = parseAnixartBookmarkExport(
      "Название\tОригинальное название\tАльтернативные названия\tСтатус просмотра\tМоя оценка\n" +
      "Тайтл\tOriginal\tAlias A; Alias B\tСмотрю\t4",
      "anixart.txt",
    );
    expect(result.snapshot.anime[0]?.titles.synonyms).toEqual(["Original", "Alias A", "Alias B"]);
    expect(result.snapshot.sourceEntries[0]).toMatchObject({ status: "WATCHING", score: 80 });
  });

  it("imports favorite-only rows without inventing a watch status", () => {
    const result = parseAnixartBookmarkExport(
      "Название;Избранное;Моя оценка\nТайтл;Да;5",
      "anixart.csv",
    );
    expect(result.snapshot.anime).toHaveLength(1);
    expect(result.snapshot.sourceEntries[0]).toMatchObject({
      status: "PLANNING",
      favorite: true,
      score: 100,
      sourceMetadata: { statusKnown: false, favoriteKnown: true },
    });
  });

  it("combines duplicate rows from separate watch and favorite lists", () => {
    const result = parseAnixartBookmarkExport(
      "ID;Название;Статус просмотра;Моя оценка\n" +
      "777;Один тайтл;Смотрю;4\n" +
      "777;Один тайтл;Избранное;4",
      "anixart.csv",
    );
    expect(result.snapshot.anime).toHaveLength(1);
    expect(result.snapshot.sourceEntries[0]).toMatchObject({
      status: "WATCHING",
      favorite: true,
      score: 80,
      sourceMetadata: { statusKnown: true, favoriteKnown: true },
    });
  });

  it("parses quoted slash-delimited TXT fields without shifting status and score", () => {
    const result = parseAnixartBookmarkExport(
      '/"Название / с разделителем"/"Original / title"/2020/12/Просмотрено/5 из 5',
      "anixart.txt",
    );
    expect(result.snapshot.anime[0]?.titles.romaji).toBe("Название / с разделителем");
    expect(result.snapshot.anime[0]?.titles.synonyms).toEqual(["Original / title"]);
    expect(result.snapshot.sourceEntries[0]).toMatchObject({ status: "COMPLETED", score: 100 });
  });

  it("extracts an exact Anixart release ID from a release URL column", () => {
    const result = parseAnixartBookmarkExport(
      "Название;Статус просмотра;Ссылка на релиз\nТайтл;Смотрю;https://anixart.site/7004-title.html",
      "anixart.csv",
    );
    expect(result.snapshot.anime[0]).toMatchObject({
      id: "anixart:7004",
      externalIds: { anixart: "7004" },
    });
  });

  it("uses deterministic title identities when the export has no release IDs", () => {
    const a = parseAnixartBookmarkExport("Title;Watch status\nExample;Watching", "anixart.csv");
    const b = parseAnixartBookmarkExport("Title;Watch status\nExample;Watching", "anixart.csv");
    expect(a.snapshot.anime[0]?.id).toBe(b.snapshot.anime[0]?.id);
    expect(a.snapshot.anime[0]?.externalIds).toEqual({});
  });

  it("keeps same-named rows distinct when original titles differ", () => {
    const result = parseAnixartBookmarkExport(
      "Название;Оригинальное название;Статус просмотра\n" +
      "Одинаковое название;Original A;Смотрю\n" +
      "Одинаковое название;Original B;Просмотрено",
      "anixart.csv",
    );
    expect(result.snapshot.anime).toHaveLength(2);
    expect(result.snapshot.anime[0]?.id).not.toBe(result.snapshot.anime[1]?.id);
  });

  it("marks blank optional fields unknown so previous source values can be preserved", () => {
    const result = parseAnixartBookmarkExport(
      "Название;Статус просмотра;Моя оценка;Избранное\n" +
      "Тайтл;Смотрю;;",
      "anixart.csv",
    );
    expect(result.snapshot.sourceEntries[0]?.sourceMetadata).toMatchObject({
      progressKnown: false, scoreKnown: false, favoriteKnown: false,
    });
  });

  it("skips unsupported status rows and rejects unknown CSV layouts", () => {
    const result = parseAnixartBookmarkExport(
      "Название;Статус просмотра\nИзбранное без статуса;Избранное\nОбычное аниме;Смотрю",
      "anixart.csv",
    );
    expect(result.snapshot.anime).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(() => parseAnixartBookmarkExport("Foo;Bar\nA;B", "anixart.csv")).toThrow(/столбцы названия и статуса/i);
  });
});
