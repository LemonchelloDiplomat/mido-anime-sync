type RouteRequest = { method?: string };
type RouteResponse = { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void };
type AnixArtRouteDependencies = { sendJson(response: RouteResponse, status: number, body: unknown): void };
export function parseAnixArtSearch(html: string): unknown[];
export function parseAnixArtDetail(html: string, requestedUrl: string): unknown;
export function handleAnixArtRequest(request: RouteRequest, response: RouteResponse, url: URL, deps: AnixArtRouteDependencies): Promise<boolean | void>;
