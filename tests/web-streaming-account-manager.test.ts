import { describe, expect, it, vi } from "vitest";
import { WebApiStreamingAccountManager } from "../src/services/platform/web-streaming-account-manager.js";

function status(provider: "animego" | "anixart") {
  return {
    provider,
    adapterAvailable: false,
    status: {
      provider,
      connected: false,
      connectedAt: null,
      expiresAt: null,
      accountLabel: null,
      state: "unsupported",
      errorMessage: null,
    },
  };
}

describe("web API streaming account manager", () => {
  it("loads status metadata without receiving provider secrets", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const provider = String(input).includes("/animego/") ? "animego" : "anixart";
      return new Response(JSON.stringify(status(provider)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const manager = new WebApiStreamingAccountManager(fetcher as typeof fetch);

    await manager.initialize();

    expect(manager.hasAdapter("animego")).toBe(false);
    expect(manager.getStatus("animego").state).toBe("unsupported");
    expect(manager.getStatus("anixart").connected).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/streaming\/accounts\//);
    }
  });

  it("sends disconnect to the local API without sending credentials", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(status("animego")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const manager = new WebApiStreamingAccountManager(fetcher as typeof fetch);

    await manager.disconnect("animego");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/streaming/accounts/animego/disconnect",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: "{}",
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("password");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("cookie");
  });

  it("rejects malformed or mismatched provider status", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(status("anixart")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const manager = new WebApiStreamingAccountManager(fetcher as typeof fetch);

    await expect(manager.restore("animego")).rejects.toThrow("invalid account status");
  });
});
