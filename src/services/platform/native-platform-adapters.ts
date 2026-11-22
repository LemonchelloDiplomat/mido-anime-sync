import type {
  StreamingHttpRequest,
  StreamingHttpResponse,
  StreamingHttpTransport,
} from "../streaming-http-client.js";
import type { StreamingSecureSecretStore } from "../streaming-account-session.js";

export interface NativeInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface CapacitorHttpPlugin {
  request(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
    responseType?: "json" | "text" | "arraybuffer";
  }): Promise<{
    status: number;
    headers?: Record<string, string>;
    data: unknown;
    url?: string;
  }>;
}

export interface CapacitorSecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string }>;
  set(options: { key: string; value: string }): Promise<unknown>;
  remove(options: { key: string }): Promise<unknown>;
}

export class TauriWindowsSecureSecretStore implements StreamingSecureSecretStore {
  constructor(private readonly invoke: NativeInvoke) {}

  get(key: string): Promise<string | null> {
    return this.invoke<string | null>("streaming_secret_get", { key });
  }

  async set(key: string, value: string): Promise<void> {
    await this.invoke<void>("streaming_secret_set", { key, value });
  }

  async remove(key: string): Promise<void> {
    await this.invoke<void>("streaming_secret_remove", { key });
  }
}

export class CapacitorAndroidSecureSecretStore implements StreamingSecureSecretStore {
  constructor(private readonly secureStorage: CapacitorSecureStoragePlugin) {}

  async get(key: string): Promise<string | null> {
    try {
      const result = await this.secureStorage.get({ key });
      return result.value;
    } catch (error) {
      if (isMissingSecureValue(error)) return null;
      throw new Error("Android Keystore secure storage could not read the session.");
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.secureStorage.set({ key, value });
    } catch {
      throw new Error("Android Keystore secure storage could not save the session.");
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.secureStorage.remove({ key });
    } catch (error) {
      if (!isMissingSecureValue(error)) {
        throw new Error("Android Keystore secure storage could not remove the session.");
      }
    }
  }
}

export class TauriWindowsStreamingHttpTransport implements StreamingHttpTransport {
  readonly platform = "windows-native" as const;

  constructor(private readonly invoke: NativeInvoke) {}

  async request<T>(request: StreamingHttpRequest): Promise<StreamingHttpResponse<T>> {
    if (request.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (request.body instanceof FormData || request.body instanceof URLSearchParams) {
      throw new Error("Tauri transport requires a serialized request body.");
    }
    const response = await this.invoke<StreamingHttpResponse<unknown>>(
      "streaming_http_request",
      {
        request: {
          url: request.url,
          method: request.method ?? "GET",
          headers: request.headers ?? {},
          ...(request.body !== undefined ? { body: typeof request.body === "string" ? request.body : toBase64(request.body) } : {}),
          responseType: request.responseType ?? "json",
          withCredentials: request.withCredentials ?? false,
        },
      },
    );
    if (request.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    let data = response.data as unknown;
    if (request.responseType === "arraybuffer" && typeof data === "string") data = fromBase64(data);
    return { ...response, data: data as T };
  }
}

export class CapacitorAndroidStreamingHttpTransport implements StreamingHttpTransport {
  readonly platform = "capacitor-android" as const;

  constructor(private readonly http: CapacitorHttpPlugin) {}

  async request<T>(request: StreamingHttpRequest): Promise<StreamingHttpResponse<T>> {
    if (request.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (request.body instanceof FormData) {
      throw new Error("Capacitor native HTTP transport requires a serialized request body.");
    }
    const response = await this.http.request({
      url: request.url,
      method: request.method ?? "GET",
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { data: request.body instanceof URLSearchParams ? request.body.toString() : request.body } : {}),
      ...(request.responseType ? { responseType: request.responseType } : {}),
      connectTimeout: 15_000,
      readTimeout: 30_000,
    });
    if (request.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    return {
      status: response.status,
      headers: normalizeHeaders(response.headers),
      data: response.data as T,
      url: response.url ?? request.url,
    };
  }
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) normalized[key.toLowerCase()] = value;
  return normalized;
}

function isMissingSecureValue(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /not.?found|missing|no.?entry|does.?not.?exist/i.test(error.message);
}

function toBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
