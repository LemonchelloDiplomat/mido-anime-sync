const DEFAULT_DATABASE_NAME = "midahoshi-anime-sync";
const TEST_DATABASE_PREFIX = "midahoshi-anime-sync-test-";
const TEST_DATABASE_PATTERN = /^midahoshi-anime-sync-test-[a-z0-9-]{1,48}$/i;

/**
 * Allows opting into an isolated IndexedDB database only on the Vite dev server.
 * Production builds always use the original database name, regardless of URL.
 */
export function resolveLibraryDatabaseName(
  search: string,
  isDevelopment: boolean,
): string {
  if (!isDevelopment) {
    return DEFAULT_DATABASE_NAME;
  }

  const params = new URLSearchParams(search);
  const values = params.getAll("database");

  if (values.length !== 1) {
    return DEFAULT_DATABASE_NAME;
  }

  const candidate = values[0];

  if (
    !candidate ||
    !candidate.startsWith(TEST_DATABASE_PREFIX) ||
    !TEST_DATABASE_PATTERN.test(candidate)
  ) {
    return DEFAULT_DATABASE_NAME;
  }

  return candidate;
}

export { DEFAULT_DATABASE_NAME };
