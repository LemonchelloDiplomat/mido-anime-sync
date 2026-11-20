type RouteRequest = { method?: string; body?: unknown };
type RouteResponse = { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void };
type TokenStore = Record<string, any>;
type YummyRouteDependencies = {
  sendJson(response: RouteResponse, status: number, body: unknown): void;
  readJson(request: RouteRequest, maxBytes?: number): Promise<any>;
  readTokens(): Promise<TokenStore>;
  writeTokens(tokens: TokenStore): Promise<void>;
};
export function handleYummyAnimeRequest(
  request: RouteRequest,
  response: RouteResponse,
  url: URL,
  deps: YummyRouteDependencies,
): Promise<boolean | void>;
