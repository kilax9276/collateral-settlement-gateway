import { describe, expect, it } from "vitest";
import { buildApp } from "../../backend/src/app.js";
import { config } from "../../backend/src/config.js";

describe("backend health route", () => {
  it("returns ok", async () => {
    const { app } = await buildApp(
      { ...config, host: "127.0.0.1", port: 0, storageDriver: "memory" },
      { logger: false, startIndexer: false },
    );
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");

    await app.close();
  });
});
