import { describe, expect, it, vi } from "vitest";
import { handleMalDelete } from "../server/mal-delete-route.mjs";

function createDependencies(overrides = {}) {
  return {
    readTokens: vi.fn().mockResolvedValue({ mal: { accessToken: "stored-token" } }),
    getAccessToken: vi.fn().mockResolvedValue("fresh-access-token"),
    clientId: "test-client-id",
    requestJson: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("MyAnimeList deletion route", () => {
  it("returns success after deleting the requested anime entry", async () => {
    const dependencies = createDependencies();

    const result = await handleMalDelete({ externalId: 12345 }, dependencies);

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(dependencies.readTokens).toHaveBeenCalledOnce();
    expect(dependencies.getAccessToken).toHaveBeenCalledWith({
      mal: { accessToken: "stored-token" },
    });
    expect(dependencies.requestJson).toHaveBeenCalledOnce();
    expect(dependencies.requestJson).toHaveBeenCalledWith(
      "https://api.myanimelist.net/v2/anime/12345/my_list_status",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it.each([undefined, null, "", 0, -1, 1.5, "not-an-id"])(
    "rejects invalid external ID %s before reading tokens",
    async (externalId) => {
      const dependencies = createDependencies();

      const result = await handleMalDelete({ externalId }, dependencies);

      expect(result.status).toBe(400);
      expect(result.body.error).toContain("Некорректный MyAnimeList ID");
      expect(dependencies.readTokens).not.toHaveBeenCalled();
      expect(dependencies.requestJson).not.toHaveBeenCalled();
    },
  );

  it("returns an error when MyAnimeList is not connected", async () => {
    const dependencies = createDependencies({
      getAccessToken: vi.fn().mockRejectedValue(
        new Error("MyAnimeList ещё не подключён."),
      ),
    });

    const result = await handleMalDelete({ externalId: 12345 }, dependencies);

    expect(result).toEqual({
      status: 502,
      body: { error: "MyAnimeList ещё не подключён." },
    });
    expect(dependencies.requestJson).not.toHaveBeenCalled();
  });

  it("preserves an HTTP error status returned by MyAnimeList", async () => {
    const dependencies = createDependencies({
      requestJson: vi.fn().mockRejectedValue(
        Object.assign(new Error("Unauthorized"), { status: 401 }),
      ),
    });

    const result = await handleMalDelete({ externalId: 12345 }, dependencies);

    expect(result).toEqual({
      status: 401,
      body: { error: "Unauthorized" },
    });
  });

  it("returns a gateway error when the local token store cannot be read", async () => {
    const dependencies = createDependencies({
      readTokens: vi.fn().mockRejectedValue(new Error("Token store unavailable")),
    });

    const result = await handleMalDelete({ externalId: 12345 }, dependencies);

    expect(result).toEqual({
      status: 502,
      body: { error: "Token store unavailable" },
    });
    expect(dependencies.getAccessToken).not.toHaveBeenCalled();
    expect(dependencies.requestJson).not.toHaveBeenCalled();
  });
});
