import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATABASE_NAME,
  resolveLibraryDatabaseName,
} from "../src/storage/database-name.js";

describe("resolveLibraryDatabaseName", () => {
  it("uses the original library database by default", () => {
    expect(resolveLibraryDatabaseName("", true)).toBe(DEFAULT_DATABASE_NAME);
    expect(resolveLibraryDatabaseName("?other=value", true)).toBe(DEFAULT_DATABASE_NAME);
  });

  it("accepts a valid isolated test database in development", () => {
    expect(
      resolveLibraryDatabaseName(
        "?database=midahoshi-anime-sync-test-pr36",
        true,
      ),
    ).toBe("midahoshi-anime-sync-test-pr36");
  });

  it("rejects names outside the dedicated test database prefix", () => {
    expect(
      resolveLibraryDatabaseName("?database=midahoshi-anime-sync", true),
    ).toBe(DEFAULT_DATABASE_NAME);
    expect(
      resolveLibraryDatabaseName("?database=another-test-db", true),
    ).toBe(DEFAULT_DATABASE_NAME);
  });

  it("rejects unsafe characters and overlong test database names", () => {
    expect(
      resolveLibraryDatabaseName(
        "?database=midahoshi-anime-sync-test-pr36%2Fproduction",
        true,
      ),
    ).toBe(DEFAULT_DATABASE_NAME);
    expect(
      resolveLibraryDatabaseName(
        `?database=midahoshi-anime-sync-test-${"a".repeat(49)}`,
        true,
      ),
    ).toBe(DEFAULT_DATABASE_NAME);
  });

  it("rejects ambiguous duplicate database parameters", () => {
    expect(
      resolveLibraryDatabaseName(
        "?database=midahoshi-anime-sync-test-one&database=midahoshi-anime-sync-test-two",
        true,
      ),
    ).toBe(DEFAULT_DATABASE_NAME);
  });

  it("always uses the original database in production", () => {
    expect(
      resolveLibraryDatabaseName(
        "?database=midahoshi-anime-sync-test-pr36",
        false,
      ),
    ).toBe(DEFAULT_DATABASE_NAME);
  });
});
