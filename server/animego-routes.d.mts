type RouteRequest = { method?: string };
type RouteResponse = { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void };
type AnimeGoRouteDependencies = { sendJson(response: RouteResponse, status: number, body: unknown): void };
export function parseAnimeGoSearch(html: string): unknown[];
export function parseAnimeGoDetail(html: string, url: string): unknown;
export function parseAnimeGoPlayer(payload: unknown, titleUrl: string): unknown;
export function handleAnimeGoRequest(request: RouteRequest, response: RouteResponse, url: URL, deps: AnimeGoRouteDependencies): Promise<boolean | void>;
