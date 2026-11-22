import type { AnimeIdentity, AnimeListEntry } from "../core/types.js";
import type { StreamingProviderId } from "./streaming-provider.js";

export type StreamingDiffAction = "add-local" | "update-local" | "export-remote" | "conflict" | "unchanged";

export interface StreamingDiffItem {
  id: string;
  provider: StreamingProviderId;
  action: StreamingDiffAction;
  identity: AnimeIdentity;
  title: string;
  localEntry: AnimeListEntry | null;
  remoteEntry: AnimeListEntry | null;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  requiresConfirmation: boolean;
}

export interface StreamingDiffPreview {
  id: string;
  provider: StreamingProviderId;
  createdAt: string;
  items: StreamingDiffItem[];
  summary: {
    addLocal: number;
    updateLocal: number;
    exportRemote: number;
    conflicts: number;
    unchanged: number;
  };
}

export interface StreamingListReadAdapter {
  readonly provider: StreamingProviderId;
  readRemoteList(signal?: AbortSignal): Promise<AnimeListEntry[]>;
}

export interface StreamingListWriteAdapter {
  readonly provider: StreamingProviderId;
  writeRemoteEntry(entry: AnimeListEntry, signal?: AbortSignal): Promise<void>;
}

/**
 * A preview is an immutable proposal, not an instruction to mutate data.
 * Applying local changes must go through the existing local reconciliation
 * service; remote writes require an explicit user-confirmed selection.
 */
export interface StreamingDiffApplier {
  applyLocal(preview: StreamingDiffPreview, selectedItemIds: string[]): Promise<void>;
  exportRemote(preview: StreamingDiffPreview, selectedItemIds: string[]): Promise<void>;
}
