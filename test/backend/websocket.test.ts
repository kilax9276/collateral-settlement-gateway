import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../../backend/src/app.js";
import { config } from "../../backend/src/config.js";
import {
  buildSignedIntentTypedData,
  buildTradingOrderIntent,
} from "../../backend/src/core/auth/signedIntentService.js";
import type { HexAddress } from "../../backend/src/types/domain.js";

const aliceAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a004497e5da46e5b01dfedb6e8f3b828cc476a3ca4c7a5e0",
);
const alice = aliceAccount.address as HexAddress;
const adminToken = "test-admin-token";
const adminHeaders = { authorization: `Bearer ${adminToken}` };

describe("WebSocket realtime stream", () => {
  it("streams system, price, order, trade, position and portfolio events", async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "collateral-settlement-gateway-ws-test-"),
    );
    const contractsFile = join(tempDir, "contracts.json");
    await writeFile(
      contractsFile,
      `${JSON.stringify(
        {
          chainId: 31337,
          network: "test",
          deployer: null,
          operator: null,
          mockUSDC: { address: null, abi: [] },
          collateralVault: { address: null, abi: [] },
          deployedAt: null,
          deploymentBlock: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { app } = await buildApp(
      {
        ...config,
        host: "127.0.0.1",
        port: 0,
        storageDriver: "memory",
        contractsFile,
        gatewayAdminToken: adminToken,
        gatewayAdminTokenConfigured: true,
      },
      { logger: false, startIndexer: false, seedBalances: { [alice]: 10_000 } },
    );
    await app.listen({ host: "127.0.0.1", port: 0 });

    const address = app.server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const messages: { type: string; payload: unknown }[] = [];

    client.on("message", (data) => {
      messages.push(
        JSON.parse(data.toString()) as { type: string; payload: unknown },
      );
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for ws open")),
        2_000,
      );
      client.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      client.once("error", reject);
    });

    await waitForEvent(messages, "system:connected");

    const price = await app.inject({
      method: "POST",
      url: "/examples/trading/market/BTC-USD/price",
      headers: adminHeaders,
      payload: { price: 66_000 },
    });
    expect(price.statusCode).toBe(200);

    const order = await signedOrder(app, "ws-buy-1");
    expect(order.statusCode).toBe(200);

    await waitForEvent(messages, "portfolio:updated");

    expect(messages.map((message) => message.type)).toEqual(
      expect.arrayContaining([
        "system:connected",
        "price:update",
        "order:created",
        "trade:executed",
        "position:updated",
        "portfolio:updated",
      ]),
    );

    client.terminate();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    await Promise.race([
      app.close(),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
    await rm(tempDir, { recursive: true, force: true });
  });
});

async function signedOrder(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  clientOrderId: string,
) {
  const nonceResponse = await app.inject({
    method: "GET",
    url: `/auth/nonce/${alice}`,
  });
  expect(nonceResponse.statusCode).toBe(200);

  const order = {
    userAddress: alice,
    symbol: "BTC-USD",
    side: "BUY" as const,
    type: "MARKET" as const,
    quantity: 0.05,
    clientOrderId,
  };
  const intent = buildTradingOrderIntent({
    order,
    nonce: nonceResponse.json().nonce,
    deadline: Math.floor(Date.now() / 1000) + 60,
  });
  const signature = await aliceAccount.signTypedData(
    buildSignedIntentTypedData({
      chainId: 31337,
      verifyingContract: zeroAddress,
      intent,
    }),
  );

  return app.inject({
    method: "POST",
    url: "/examples/trading/orders",
    payload: { order, intent, signature },
  });
}

async function waitForEvent(
  messages: { type: string; payload: unknown }[],
  type: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (messages.some((message) => message.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for websocket event: ${type}`);
}
