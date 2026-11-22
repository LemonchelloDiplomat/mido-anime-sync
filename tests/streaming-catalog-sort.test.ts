import { describe, expect, it } from "vitest";
import { sortStreamingTitles, type StreamingTitle } from "../src/services/streaming-provider.js";

function title(externalId: string, name: string, rating: number | null = null, year: number | null = null): StreamingTitle {
  return {
    provider: "animego",
    externalId,
    url: "https://example.test/" + externalId,
    title: name,
    alternativeTitles: [],
    rating,
    year,
  };
}

describe("streaming catalog sorting", () => {
  const items = [
    title("1", "Наруто 10", 8.5, 2007),
    title("2", "Боруто", null, 2017),
    title("3", "Наруто 2", 9.1, 2002),
    title("4", "Атака титанов", 8.8, null),
  ];

  it("preserves provider relevance order by default", () => {
    expect(sortStreamingTitles(items, "source")).toEqual(items);
  });

  it("sorts titles naturally and respects the selected locale", () => {
    expect(sortStreamingTitles(items, "title", "ru").map((item) => item.title)).toEqual([
      "Атака титанов", "Боруто", "Наруто 2", "Наруто 10",
    ]);
  });

  it("sorts ratings descending and keeps missing ratings last", () => {
    expect(sortStreamingTitles(items, "rating").map((item) => item.externalId)).toEqual(["3", "4", "1", "2"]);
  });

  it("sorts years newest first and keeps missing years last", () => {
    expect(sortStreamingTitles(items, "year").map((item) => item.externalId)).toEqual(["2", "1", "3", "4"]);
  });

  it("does not mutate the provider result array", () => {
    const original = [...items];
    sortStreamingTitles(items, "rating");
    expect(items).toEqual(original);
  });
});
