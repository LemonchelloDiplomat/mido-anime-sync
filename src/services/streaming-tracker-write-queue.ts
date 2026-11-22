export interface ConfirmedTrackerWrite {
  externalId: string;
  listId: number;
}
export interface TrackerWriteResult {
  succeeded: ConfirmedTrackerWrite[];
  failed: ConfirmedTrackerWrite | null;
  error: string | null;
  cancelled: boolean;
}
/**
 * Runs only user-confirmed writes in order. Stops at the first failure so the
 * caller can refresh remote state before deciding whether to resume.
 * This is an in-process queue, not a durable background job.
 */
export async function runConfirmedTrackerWrites(
  operations: readonly ConfirmedTrackerWrite[],
  write: (operation: ConfirmedTrackerWrite) => Promise<void>,
  signal?: AbortSignal,
): Promise<TrackerWriteResult> {
  const result: TrackerWriteResult = { succeeded: [], failed: null, error: null, cancelled: false };
  for (const operation of operations) {
    if (signal?.aborted) { result.cancelled = true; break; }
    try {
      await write(operation);
      result.succeeded.push(operation);
    } catch (error) {
      result.failed = operation;
      result.error = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  return result;
}
