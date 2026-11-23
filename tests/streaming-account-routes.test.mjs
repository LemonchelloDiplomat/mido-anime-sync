import { describe, expect, it, vi } from "vitest";
import { handleStreamingAccountRequest } from "../server/streaming-account-routes.mjs";

function createResponse() {
  return {
    status: 0,
    body: null,
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function sendJson(response, status, body) {
  response.status = status;
  response.body = body;
  return body;
}

describe("local web streaming account routes", () => {
  it("reports unsupported adapters without exposing session material", async () => {
    const response = createResponse();
    const handled = await handleStreamingAccountRequest(
      { method: "GET" },
      response,
      new URL("http://127.0.0.1:3001/api/streaming/accounts/animego/status"),
      { sendJson: (res, status, body) => sendJson(res, status, body) },
    );

    expect(handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      provider: "animego",
      adapterAvailable: false,
      status: { connected: false, state: "unsupported" },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/password|cookie|token/i);
  });

  it("keeps disconnect idempotent until a provider adapter exists", async () => {
    const response = createResponse();
    await handleStreamingAccountRequest(
      { method: "POST" },
      response,
      new URL("http://127.0.0.1:3001/api/streaming/accounts/anixart/disconnect"),
      { sendJson: (res, status, body) => sendJson(res, status, body) },
    );

    expect(response.status).toBe(200);
    expect(response.body.status.state).toBe("unsupported");
  });

  it("does not handle unrelated routes", async () => {
    const response = createResponse();
    const handled = await handleStreamingAccountRequest(
      { method: "GET" },
      response,
      new URL("http://127.0.0.1:3001/api/streaming/accounts/mal/status"),
      { sendJson: (res, status, body) => sendJson(res, status, body) },
    );

    expect(handled).toBe(false);
    expect(response.status).toBe(0);
  });
});
