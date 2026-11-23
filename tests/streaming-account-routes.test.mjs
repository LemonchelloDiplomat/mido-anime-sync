import { describe, expect, it, vi } from "vitest";
import { handleStreamingAccountRequest } from "../server/streaming-account-routes.mjs";

function createResponse() {
  return { status: 0, body: null, writeHead: vi.fn(), end: vi.fn() };
}

function sendJson(response, status, body) {
  response.status = status;
  response.body = body;
  return body;
}

function store(initial = {}) {
  let tokens = structuredClone(initial);
  return {
    readTokens: vi.fn(async () => structuredClone(tokens)),
    writeTokens: vi.fn(async (next) => { tokens = structuredClone(next); }),
    snapshot: () => structuredClone(tokens),
  };
}

describe("local web streaming account routes", () => {
  it("reports AnimeGO adapter availability without exposing session material", async () => {
    const response = createResponse();
    const deps = {
      sendJson: (res, status, body) => sendJson(res, status, body),
      ...store(),
      fetcher: vi.fn(async () => new Response("<html></html>", { status: 200 })),
    };
    await handleStreamingAccountRequest(
      { method: "GET", headers: {} },
      response,
      new URL("http://127.0.0.1:3001/api/streaming/accounts/animego/status"),
      deps,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      provider: "animego",
      adapterAvailable: true,
      status: { connected: false, state: "disconnected" },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/password|cookie|token/i);
  });

  it("keeps Anixart disabled until a permitted account API exists", async () => {
    const response = createResponse();
    await handleStreamingAccountRequest(
      { method: "GET", headers: {} },
      response,
      new URL("http://127.0.0.1:3001/api/streaming/accounts/anixart/status"),
      { sendJson: (res, status, body) => sendJson(res, status, body) },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      provider: "anixart",
      adapterAvailable: false,
      status: { connected: false, state: "unsupported" },
    });
  });

  it("rejects credential submission from a non-loopback origin", async () => {
    const response = createResponse();
    const readJson = vi.fn();
    await handleStreamingAccountRequest(
      { method: "POST", headers: { origin: "https://example.com" } },
      response,
      new URL("http://127.0.0.1:3001/api/streaming/accounts/animego/connect"),
      {
        sendJson: (res, status, body) => sendJson(res, status, body),
        readJson,
        ...store(),
      },
    );

    expect(response.status).toBe(403);
    expect(readJson).not.toHaveBeenCalled();
  });

  it("does not handle unrelated routes", async () => {
    const response = createResponse();
    const handled = await handleStreamingAccountRequest(
      { method: "GET", headers: {} },
      response,
      new URL("http://127.0.0.1:3001/api/streaming/accounts/mal/status"),
      { sendJson: (res, status, body) => sendJson(res, status, body) },
    );

    expect(handled).toBe(false);
    expect(response.status).toBe(0);
  });
});
