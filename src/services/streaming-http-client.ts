import type { StreamingProviderId } from "./streaming-provider.js";

export type StreamingHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type StreamingHttpResponseType = "json" | "text" | "arraybuffer";

export interface StreamingHttpRequest {
  provider: StreamingProviderId;
  url: string;
  method?: StreamingHttpMethod;
  headers?: Record<string, string>;
  body?: string | FormData | URLSearchParams | ArrayBuffer;
  responseType?: StreamingHttpResponseType;
  signal?: AbortSignal;
  /** Include only when a provider's documented flow requires its session cookies. */
  withCredentials?: boolean;
}

export interface StreamingHttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  url: string;
}

export interface StreamingHttpTransport {
  readonly platform: "capacitor-android" | "windows-native";
  request<T = unknown>(request: StreamingHttpRequest): Promise<StreamingHttpResponse<T>>;
}

/** Minimal structural subset of @capacitor/core's native HTTP plugin. */
export interface CapacitorHttpPluginLike {
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

/**
 * Android transport. The host injects CapacitorHttp, which performs requests
 * natively and is not subject to browser CORS enforcement.
 */
export class CapacitorStreamingHttpTransport implements StreamingHttpTransport {
  readonly platform = "capacitor-android" as const;

  constructor(private readonly http: CapacitorHttpPluginLike) {}

  async request<T>(request: StreamingHttpRequest): Promise<StreamingHttpResponse<T>> {
    if (request.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    const response = await this.http.request({
      url: request.url,
      method: request.method ?? "GET",
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { data: request.body } : {}),
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

/** Payload contract expected from a Tauri command or Electron main-process IPC. */
export interface WindowsNativeHttpBridge {
  request(payload: {
    url: string;
    method: StreamingHttpMethod;
    headers: Record<string, string>;
    body?: string | ArrayBuffer;
    responseType: StreamingHttpResponseType;
    withCredentials: boolean;
  }): Promise<{
    status: number;
    headers?: Record<string, string>;
    data: unknown;
    url?: string;
  }>;
}

/**
 * Windows transport. The bridge must execute in the trusted native process
 * (Tauri command or Electron main process), never in a renderer-side fetch.
 * Cookie/header handling must be explicit and secrets must be redacted in logs.
 */
export class WindowsNativeStreamingHttpTransport implements StreamingHttpTransport {
  readonly platform = "windows-native" as const;

  constructor(private readonly bridge: WindowsNativeHttpBridge) {}

  async request<T>(request: StreamingHttpRequest): Promise<StreamingHttpResponse<T>> {
    if (request.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (request.body instanceof FormData || request.body instanceof URLSearchParams) {
      throw new Error("Windows native bridge accepts serialized bodies only; encode FormData explicitly.");
    }
    const response = await this.bridge.request({
      url: request.url,
      method: request.method ?? "GET",
      headers: request.headers ?? {},
      ...(request.body !== undefined ? { body: request.body } : {}),
      responseType: request.responseType ?? "json",
      withCredentials: request.withCredentials ?? false,
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

/**
 * Shared facade. There is deliberately no fetch/browser fallback: silently
 * falling back would reintroduce CORS failures and may leak credentials.
 */
export class StreamingHttpClient {
  constructor(private readonly transport: StreamingHttpTransport) {}

  async request<T = unknown>(request: StreamingHttpRequest): Promise<StreamingHttpResponse<T>> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("Streaming account requests require HTTPS.");
    }
    const response = await this.transport.request<T>(request);
    if (response.status < 200 || response.status >= 300) {
      throw new StreamingHttpError(response.status, request.provider, request.url, response.data);
    }
    return response;
  }
}

export class StreamingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly provider: StreamingProviderId,
    requestUrl: string,
    readonly responseBody: unknown,
  ) {
    super(`Streaming request failed (${status}) for ${provider}: ${safeUrl(requestUrl)}`);
    this.name = "StreamingHttpError";
  }
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) normalized[key.toLowerCase()] = value;
  return normalized;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}
