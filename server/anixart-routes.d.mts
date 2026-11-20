import type { AnimeIdentity } from "../src/core/types.js";
import type { StreamingTitle, StreamingTitleDetails } from "../src/services/streaming-provider.js";
type RouteRequest = { method?: string };
type RouteResponse = { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void };
type AnixArtRouteDependencies = { sendJson(response: RouteResponse, status: number, body: unknown): void; fetch?: typeof fetch };
export function parseAnixArtSearch(html: string): StreamingTitle[];
export function parseAnixArtDetail(html: string, requestedUrl: string): StreamingTitleDetails & { identity: AnimeIdentity; sourceMetadata?: Record<string, unknown> };
export function parseAnixArtPlayerPlaylist(payload: unknown, titleUrl: string): { seasons: StreamingTitleDetails["seasons"]; voices: StreamingTitleDetails["voices"]; episodeCount: number };
export function handleAnixArtRequest(request: RouteRequest, response: RouteResponse, url: URL, deps: AnixArtRouteDependencies): Promise<boolean | void>;
