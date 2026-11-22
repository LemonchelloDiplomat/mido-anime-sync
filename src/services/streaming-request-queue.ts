import type { StreamingProviderId } from "./streaming-provider.js";

export interface StreamingQueueOptions {
  /** Minimum interval between starts for requests to the same provider. */
  minIntervalMs?: number;
  /** Optional abort signal for a queued item. */
  signal?: AbortSignal;
}

/**
 * Serializes writes per provider and enforces a 1–2 second minimum interval.
 * Default is 1500 ms. Queues are isolated per provider.
 */
export class StreamingRequestQueue {
  private readonly tails = new Map<StreamingProviderId, Promise<void>>();
  private readonly lastStartedAt = new Map<StreamingProviderId, number>();

  async enqueue<T>(
    provider: StreamingProviderId,
    task: () => Promise<T>,
    options: StreamingQueueOptions = {},
  ): Promise<T> {
    const minIntervalMs = options.minIntervalMs ?? 1500;
    if (minIntervalMs < 1000 || minIntervalMs > 2000) {
      throw new RangeError("Provider request interval must be between 1000 and 2000 ms.");
    }

    const previous = this.tails.get(provider) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(provider, tail);

    await previous.catch(() => undefined);
    try {
      if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      const last = this.lastStartedAt.get(provider);
      if (last !== undefined) {
        await abortableDelay(Math.max(0, minIntervalMs - (Date.now() - last)), options.signal);
      }
      if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      this.lastStartedAt.set(provider, Date.now());
      return await task();
    } finally {
      release();
      if (this.tails.get(provider) === tail) this.tails.delete(provider);
    }
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
