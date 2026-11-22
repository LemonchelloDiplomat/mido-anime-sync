import { describe, expect, it, vi } from "vitest";
import {
  CapacitorStreamingHttpTransport,
  StreamingHttpClient,
  WindowsNativeStreamingHttpTransport,
} from "../src/services/streaming-http-client.js";

describe("streaming HTTP client", () => {
  it("passes provider headers through the Capacitor native transport", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200, headers: { "Content-Type": "text/html" }, data: "<html/>", url: "https://animego.example/list",
    });
    const client = new StreamingHttpClient(new CapacitorStreamingHttpTransport({ request }));

    const response = await client.request<string>({
      provider: "animego",
      url: "https://animego.example/list",
      headers: { Cookie: "session=secret", "User-Agent": "MidoAnimeSync", "X-CSRF-TOKEN": "csrf" },
      responseType: "text",
      withCredentials: true,
    });

    expect(response.data).toBe("<html/>");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      headers: { Cookie: "session=secret", "User-Agent": "MidoAnimeSync", "X-CSRF-TOKEN": "csrf" },
      responseType: "text",
    }));
  });

  it("delegates Windows requests to the trusted native bridge", async () => {
    const request = vi.fn().mockResolvedValue({ status: 204, data: null });
    const client = new StreamingHttpClient(new WindowsNativeStreamingHttpTransport({ request }));

    await client.request({
      provider: "anixart",
      url: "https://anixart.example/api",
      method: "POST",
      headers: { Authorization: "Bearer opaque" },
      body: "{\"status\":\"watching\"}",
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer opaque" },
      withCredentials: false,
    }));
  });

  it("rejects non-HTTPS remote URLs before transport", async () => {
    const request = vi.fn();
    const client = new StreamingHttpClient(new CapacitorStreamingHttpTransport({ request }));

    await expect(client.request({ provider: "animego", url: "http://animego.example/list" }))
      .rejects.toThrow("require HTTPS");
    expect(request).not.toHaveBeenCalled();
  });

  it("surfaces non-2xx provider responses as typed errors", async () => {
    const request = vi.fn().mockResolvedValue({ status: 401, data: { message: "Unauthorized" } });
    const client = new StreamingHttpClient(new WindowsNativeStreamingHttpTransport({ request }));

    await expect(client.request({ provider: "anixart", url: "https://anixart.example/api" }))
      .rejects.toMatchObject({ name: "StreamingHttpError", status: 401, provider: "anixart" });
  });
});
