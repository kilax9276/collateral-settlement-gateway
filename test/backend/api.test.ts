import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zeroAddress } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../backend/src/app.js";
import { config } from "../../backend/src/config.js";
import {
  buildSignedIntentTypedData,
  buildTradingOrderIntent,
} from "../../backend/src/core/auth/signedIntentService.js";
import type {
  HexAddress,
  SignedIntent,
  SignedOrderPayload,
} from "../../backend/src/types/domain.js";

const aliceAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a004497e5da46e5b01dfedb6e8f3b828cc476a3ca4c7a5e0",
);
const bobAccount = mnemonicToAccount(
  "test test test test test test test test test test test junk",
  { accountIndex: 2 },
);
const alice = aliceAccount.address as HexAddress;
const bob = bobAccount.address as HexAddress;
const adminToken = "test-admin-token";
const adminHeaders = { authorization: `Bearer ${adminToken}` };
const fantasyAppHeaders = {
  "x-app-id": "fantasy-trading-app",
  "x-app-secret": "test-external-secret",
};
const tradingAppHeaders = {
  "x-app-id": "trading-example",
  "x-app-secret": "test-trading-secret",
};
const registeredApps =
  "trading-example:test-trading-secret,fantasy-trading-app:test-external-secret";

type TestSigner = {
  signTypedData: (
    typedData: ReturnType<typeof buildSignedIntentTypedData>,
  ) => Promise<`0x${string}`>;
};

let app: FastifyInstance;
let tempDir: string;
let tempContractsFile: string;

beforeEach(async () => {
  tempDir = await mkdtemp(
    join(tmpdir(), "collateral-settlement-gateway-api-test-"),
  );
  tempContractsFile = join(tempDir, "contracts.json");
  await writeFile(
    tempContractsFile,
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

  const built = await buildApp(
    {
      ...config,
      host: "127.0.0.1",
      port: 0,
      defaultBtcPrice: 65_000,
      takerFeeBps: 5,
      storageDriver: "memory",
      contractsFile: tempContractsFile,
      enableDemoRoutes: true,
      gatewayAdminToken: adminToken,
      gatewayAdminTokenConfigured: true,
      registeredApps,
    },
    { logger: false, seedBalances: { [alice]: 10_000 }, startIndexer: false },
  );
  app = built.app;
});

afterEach(async () => {
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("backend API", () => {
  it("serves the local demo console when demo routes are enabled", async () => {
    const response = await app.inject({ method: "GET", url: "/dashboard" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(
      "Collateral Settlement Gateway Operator Console",
    );
    expect(response.body).toContain("Gateway Overview");
    expect(response.body).toContain("Settlement Audit");
    expect(response.body).toContain("Demo Walkthrough");
  });

  it("keeps demo routes disabled by default", async () => {
    const disabled = await buildApp(
      {
        ...config,
        host: "127.0.0.1",
        port: 0,
        storageDriver: "memory",
        contractsFile: tempContractsFile,
        enableDemoRoutes: false,
        gatewayAdminToken: adminToken,
        gatewayAdminTokenConfigured: true,
        registeredApps,
      },
      { logger: false, startIndexer: false },
    );

    try {
      const demo = await disabled.app.inject({
        method: "POST",
        url: "/demo/mint",
      });
      expect(demo.statusCode).toBe(404);

      const health = await disabled.app.inject({
        method: "GET",
        url: "/health",
      });
      expect(health.statusCode).toBe(200);
    } finally {
      await disabled.app.close();
    }
  });

  it("serves OpenAPI JSON and Swagger UI docs", async () => {
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    const spec = openapi.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.components.securitySchemes.AdminBearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(spec.components.securitySchemes.AppAuthHeaders).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "X-App-Id",
    });
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/intents/verify"]).toBeDefined();
    expect(spec.paths["/settlements"]).toBeDefined();
    expect(spec.paths["/settlements/{settlementId}"]).toBeDefined();
    expect(spec.paths["/settlements/{settlementId}/report"]).toBeDefined();
    expect(spec.paths["/examples/trading/orders"]).toBeDefined();
    expect(
      spec.paths["/examples/trading/positions/{userAddress}"],
    ).toBeDefined();
    expect(spec.paths["/examples/trading/market/{symbol}/price"]).toBeDefined();
    expect(spec.paths["/admin/reconciliation/{userAddress}"]).toBeDefined();
    expect(spec.paths["/admin/system-health"]).toBeDefined();
    expect(spec.paths["/admin/gateway-metrics"]).toBeDefined();
    expect(spec.paths["/admin/recent-events"]).toBeDefined();
    expect(spec.paths["/admin/recent-settlements"]).toBeDefined();
    expect(spec.paths["/admin/recent-intents"]).toBeDefined();
    expect(spec.paths["/admin/pending-withdrawals"]).toBeDefined();
    expect(spec.paths["/admin/pending-settlements"]).toBeDefined();
    expect(spec.paths["/demo/mint"]).toBeDefined();
    expect(spec.paths["/demo/settle"]).toBeDefined();

    const tags = spec.tags.map((tag: { name: string }) => tag.name);
    expect(tags).toEqual(
      expect.arrayContaining([
        "Core Gateway",
        "Signed Intents",
        "Collateral",
        "Settlements",
        "Withdrawals",
        "Reconciliation",
        "Admin",
        "Trading Example",
        "Demo Only",
      ]),
    );
    expect(spec.paths["/intents/verify"].post.tags).toContain("Signed Intents");
    expect(spec.paths["/settlements"].post.tags).toContain("Settlements");
    expect(spec.paths["/settlements/{settlementId}/report"].get.tags).toContain(
      "Settlements",
    );
    expect(
      spec.paths["/admin/reconciliation/{userAddress}"].get.tags,
    ).toContain("Reconciliation");
    expect(spec.paths["/admin/system-health"].get.tags).toContain("Admin");
    expect(spec.paths["/examples/trading/orders"].post.tags).toContain(
      "Trading Example",
    );
    expect(spec.paths["/demo/mint"].post.tags).toContain("Demo Only");
    expect(spec.paths["/demo/mint"].post.description).toContain(
      "Demo only. Disabled unless ENABLE_DEMO_ROUTES=true.",
    );
    expect(spec.paths["/settlements"].post.security).toEqual([
      { AdminBearerAuth: [] },
      { AppAuthHeaders: [] },
    ]);
    expect(spec.paths["/admin/system-health"].get.security).toEqual([
      { AdminBearerAuth: [] },
    ]);
    expect(spec.paths["/admin/gateway-metrics"].get.security).toEqual([
      { AdminBearerAuth: [] },
    ]);
    expect(
      spec.paths["/examples/trading/market/{symbol}/price"].post.security,
    ).toEqual([{ AdminBearerAuth: [] }]);
    expect(
      spec.paths["/settlements"].post.requestBody.content["application/json"]
        .schema.example,
    ).toMatchObject({ signedIntentIds: ["intent_abc123"] });
    expect(
      spec.paths["/settlements/{settlementId}/report"].get.responses[200]
        .content["application/json"].schema.example,
    ).toMatchObject({ linkedSignedIntents: expect.any(Array) });
    expect(
      spec.paths["/withdrawals/request"].post.requestBody.content[
        "application/json"
      ].schema.example,
    ).toMatchObject({ signedIntentId: "intent_withdrawal_abc123" });
    expect(
      spec.paths["/admin/reconciliation/{userAddress}"].get.responses[200]
        .content["application/json"].schema.example,
    ).toMatchObject({ status: "OK", detectedIssues: [] });

    const dashboardScript = await readFile(
      new URL("../../dashboard/app.js", import.meta.url),
      "utf8",
    );
    for (const dashboardEndpoint of [
      "/admin/gateway-metrics",
      "/admin/recent-events",
      "/admin/recent-settlements",
      "/admin/recent-intents",
      "/admin/pending-withdrawals",
      "/admin/pending-settlements",
    ]) {
      expect(dashboardScript).toContain(dashboardEndpoint);
      expect(spec.paths[dashboardEndpoint]).toBeDefined();
    }

    const externalClientFiles = [
      "../../examples/external-client/client.ts",
      "../../examples/external-client/signedIntent.ts",
      "../../examples/external-client/types.ts",
    ];
    for (const file of externalClientFiles) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      expect(source).not.toContain("../../backend/src");
      expect(source).not.toContain("../backend/src");
    }

    const externalClientReadme = await readFile(
      new URL("../../examples/external-client/README.md", import.meta.url),
      "utf8",
    );
    expect(externalClientReadme).toContain("npm run example:external-client");
    expect(externalClientReadme).toContain("EXTERNAL_APP_PRIVATE_KEY");
    expect(externalClientReadme).toContain("signedIntent.ts");
  });

  it("serves operator metrics endpoints only with admin token", async () => {
    const protectedEndpoints = [
      "/admin/gateway-metrics",
      "/admin/recent-events",
      "/admin/recent-settlements",
      "/admin/recent-intents",
      "/admin/pending-withdrawals",
      "/admin/pending-settlements",
    ];

    for (const url of protectedEndpoints) {
      const unauthorized = await app.inject({ method: "GET", url });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json().error.code).toBe("ADMIN_AUTH_REQUIRED");

      const authorized = await app.inject({
        method: "GET",
        url,
        headers: adminHeaders,
      });
      expect(authorized.statusCode).toBe(200);
    }

    const metrics = await app.inject({
      method: "GET",
      url: "/admin/gateway-metrics",
      headers: adminHeaders,
    });
    expect(metrics.json()).toMatchObject({
      chainId: 31337,
      indexer: {
        enabled: expect.any(Boolean),
        status: expect.stringMatching(/^(running|stopped|disabled)$/),
        lastProcessedBlock: null,
        lagBlocks: null,
      },
      storage: { driver: "memory", status: "OK" },
      collateral: {
        totalUsers: expect.any(Number),
        totalUserCollateral: expect.any(Number),
        totalLiabilities: null,
        insuranceBalance: null,
      },
      operations: {
        pendingWithdrawals: expect.any(Number),
        pendingSettlements: expect.any(Number),
        recentSettlements: expect.any(Number),
        recentSignedIntents: expect.any(Number),
      },
      tradingExample: {
        openPositions: expect.any(Number),
        supportedSymbols: expect.arrayContaining(["BTC-USD"]),
      },
      reconciliationSummary: {
        OK: expect.any(Number),
        WARNING: expect.any(Number),
        MISMATCH: expect.any(Number),
      },
    });
  });

  it("uses a consistent nested error format for 401, 400 and 404", async () => {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/admin/gateway-metrics",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({
      error: {
        code: "ADMIN_AUTH_REQUIRED",
        message: expect.any(String),
      },
    });

    const badRequest = await app.inject({
      method: "POST",
      url: "/examples/trading/market/BTC-USD/price",
      headers: adminHeaders,
      payload: { price: -1 },
    });
    expect(badRequest.statusCode).toBe(400);
    expect(badRequest.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: expect.any(String),
        details: expect.any(Array),
      },
    });

    const notFound = await app.inject({ method: "GET", url: "/no-such-route" });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: expect.any(String) },
    });
  });

  it("returns health, contracts config and auth nonce", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");

    const contracts = await app.inject({ method: "GET", url: "/contracts" });
    expect(contracts.statusCode).toBe(200);
    expect(contracts.json().chainId).toBe(31337);

    const nonce = await app.inject({
      method: "GET",
      url: `/auth/nonce/${alice}`,
    });
    expect(nonce.statusCode).toBe(200);
    expect(nonce.json().userAddress).toBe(alice);
    expect(nonce.json().nonce).toMatch(/^intentnonce_/);
  });

  it("protects admin/operator endpoints with the admin bearer token", async () => {
    const withoutToken = await app.inject({
      method: "POST",
      url: "/examples/trading/market/BTC-USD/price",
      payload: { price: 66_000 },
    });
    expect(withoutToken.statusCode).toBe(401);
    expect(withoutToken.json().error.code).toBe("ADMIN_AUTH_REQUIRED");

    const wrongToken = await app.inject({
      method: "GET",
      url: "/admin/system-health",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrongToken.statusCode).toBe(401);
    expect(wrongToken.json().error.code).toBe("ADMIN_AUTH_REQUIRED");

    const settlementWithoutToken = await app.inject({
      method: "POST",
      url: "/settlements",
      payload: genericSettlementRequest(),
    });
    expect(settlementWithoutToken.statusCode).toBe(401);

    const approvalWithoutToken = await app.inject({
      method: "POST",
      url: `/withdrawals/approve/${alice}`,
      payload: { amount: 100 },
    });
    expect(approvalWithoutToken.statusCode).toBe(401);

    const validToken = await app.inject({
      method: "POST",
      url: "/examples/trading/market/BTC-USD/price",
      headers: adminHeaders,
      payload: { price: 66_000 },
    });
    expect(validToken.statusCode).toBe(200);
    expect(validToken.json().price).toBe(66_000);

    const publicHealth = await app.inject({ method: "GET", url: "/health" });
    expect(publicHealth.statusCode).toBe(200);

    const publicContracts = await app.inject({
      method: "GET",
      url: "/contracts",
    });
    expect(publicContracts.statusCode).toBe(200);
  });

  it("authorizes external app settlements through registered app credentials", async () => {
    const missingCredentials = await app.inject({
      method: "POST",
      url: "/settlements",
      payload: genericSettlementRequest({
        appId: "fantasy-trading-app",
        settlementType: "EXTERNAL_APP_REWARD",
      }),
    });
    expect(missingCredentials.statusCode).toBe(401);
    expect(missingCredentials.json().error.code).toBe("APP_AUTH_REQUIRED");

    const wrongSecret = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: {
        "x-app-id": "fantasy-trading-app",
        "x-app-secret": "wrong-secret",
      },
      payload: genericSettlementRequest({
        appId: "fantasy-trading-app",
        settlementType: "EXTERNAL_APP_REWARD",
      }),
    });
    expect(wrongSecret.statusCode).toBe(401);
    expect(wrongSecret.json().error.code).toBe("APP_AUTH_REQUIRED");

    const appIdMismatch = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: fantasyAppHeaders,
      payload: genericSettlementRequest({
        appId: "trading-example",
        settlementType: "TRADING_PNL",
      }),
    });
    expect(appIdMismatch.statusCode).toBe(403);
    expect(appIdMismatch.json().error.code).toBe("APP_ID_MISMATCH");

    const disallowedSettlementType = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: fantasyAppHeaders,
      payload: genericSettlementRequest({
        appId: "fantasy-trading-app",
        settlementType: "TRADING_PNL",
      }),
    });
    expect(disallowedSettlementType.statusCode).toBe(403);
    expect(disallowedSettlementType.json().error.code).toBe(
      "SETTLEMENT_TYPE_NOT_ALLOWED",
    );

    const appSettlementWithoutIntent = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: fantasyAppHeaders,
      payload: genericSettlementRequest({
        appId: "fantasy-trading-app",
        settlementType: "EXTERNAL_APP_REWARD",
      }),
    });
    expect(appSettlementWithoutIntent.statusCode).toBe(409);
    expect(appSettlementWithoutIntent.json().error.code).toBe(
      "SIGNED_INTENTS_REQUIRED_FOR_APP_SETTLEMENT",
    );

    const verifiedIntent = await verifyGenericIntent({
      appId: "fantasy-trading-app",
      intentType: "EXTERNAL_APP_REWARD",
    });
    const validAppCredentials = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: fantasyAppHeaders,
      payload: genericSettlementRequest({
        appId: "fantasy-trading-app",
        settlementType: "EXTERNAL_APP_REWARD",
        signedIntentIds: [verifiedIntent.intentId],
      }),
    });
    expect(validAppCredentials.statusCode).toBe(409);
    expect(validAppCredentials.json().error.code).toBe(
      "CONTRACT_DEPLOYMENT_NOT_READY",
    );

    const tradingAppDisallowed = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: tradingAppHeaders,
      payload: genericSettlementRequest({
        appId: "trading-example",
        settlementType: "EXTERNAL_APP_REWARD",
      }),
    });
    expect(tradingAppDisallowed.statusCode).toBe(403);
    expect(tradingAppDisallowed.json().error.code).toBe(
      "SETTLEMENT_TYPE_NOT_ALLOWED",
    );
  });

  it("validates settlement linked signed intents before app settlements", async () => {
    const unknownIntent = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: fantasyAppHeaders,
      payload: genericSettlementRequest({
        appId: "fantasy-trading-app",
        settlementType: "EXTERNAL_APP_REWARD",
        signedIntentIds: ["intent_missing"],
      }),
    });
    expect(unknownIntent.statusCode).toBe(409);
    expect(unknownIntent.json().error.code).toBe("SIGNED_INTENT_NOT_FOUND");

    const wrongUserIntent = await verifyGenericIntent(
      {
        userAddress: bob,
        appId: "fantasy-trading-app",
        intentType: "EXTERNAL_APP_REWARD",
      },
      bobAccount,
    );
    const wrongUser = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: fantasyAppHeaders,
      payload: genericSettlementRequest({
        appId: "fantasy-trading-app",
        settlementType: "EXTERNAL_APP_REWARD",
        signedIntentIds: [wrongUserIntent.intentId],
      }),
    });
    expect(wrongUser.statusCode).toBe(409);
    expect(wrongUser.json().error.code).toBe("SIGNED_INTENT_USER_MISMATCH");

    const wrongAppIntent = await verifyGenericIntent({
      appId: "trading-example",
      intentType: "TRADING_ORDER",
    });
    const wrongApp = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: fantasyAppHeaders,
      payload: genericSettlementRequest({
        appId: "fantasy-trading-app",
        settlementType: "EXTERNAL_APP_REWARD",
        signedIntentIds: [wrongAppIntent.intentId],
      }),
    });
    expect(wrongApp.statusCode).toBe(409);
    expect(wrongApp.json().error.code).toBe("SIGNED_INTENT_APP_MISMATCH");
  });

  it("rejects signed intents for unregistered applications", async () => {
    const payload = await genericIntentPayload({ appId: "unknown-app" });

    const response = await app.inject({
      method: "POST",
      url: "/intents/verify",
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("APP_NOT_REGISTERED");
  });

  it("requires the admin token for enabled demo routes", async () => {
    const withoutToken = await app.inject({
      method: "GET",
      url: "/demo/state",
    });
    expect(withoutToken.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "POST",
      url: "/demo/mint",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrongToken.statusCode).toBe(401);

    const validToken = await app.inject({
      method: "GET",
      url: "/demo/state",
      headers: adminHeaders,
    });
    expect(validToken.statusCode).toBe(200);
    expect(validToken.json().demoOnly).toBe(true);
  });

  it("returns seeded in-memory portfolio", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/portfolio/${alice}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().collateral).toBe(10_000);
    expect(response.json().positions).toHaveLength(0);
  });

  it("accepts and stores a valid generic signed intent", async () => {
    const payload = await genericIntentPayload({ intentType: "REWARD_CLAIM" });

    const verified = await app.inject({
      method: "POST",
      url: "/intents/verify",
      payload,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      valid: true,
      signer: alice,
      status: "VERIFIED",
      nonceConsumed: true,
      intent: {
        appId: "fantasy-trading-app",
        intentType: "REWARD_CLAIM",
      },
    });
    expect(verified.json().intentId).toMatch(/^intent_/);
  });

  it("rejects expired generic signed intents", async () => {
    const payload = await genericIntentPayload({ deadline: 1 });

    const response = await app.inject({
      method: "POST",
      url: "/intents/verify",
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INTENT_EXPIRED");
  });

  it("prevents generic signed intent replay", async () => {
    const payload = await genericIntentPayload({ intentType: "GAME_ACTION" });

    const first = await app.inject({
      method: "POST",
      url: "/intents/verify",
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/intents/verify",
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("INTENT_NONCE_ALREADY_USED");
  });

  it("executes trading orders through the generic signed-intent flow", async () => {
    const payload = await signedOrderPayload({
      clientOrderId: "verify-intent-1",
    });

    const order = await app.inject({
      method: "POST",
      url: "/examples/trading/orders",
      payload,
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().order.clientOrderId).toBe("verify-intent-1");
  });

  it("returns trading example positions under /examples/trading", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/examples/trading/positions/${alice}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userAddress: alice.toLowerCase(),
      positions: [],
    });
  });

  it("opens a long, updates price, closes it and requires deployed Vault for settlement", async () => {
    const buy = await postSignedOrder({
      side: "BUY",
      quantity: 0.05,
      clientOrderId: "buy-1",
    });

    expect(buy.statusCode).toBe(200);
    expect(buy.json().trade.latencyMs).toBeLessThan(100);
    expect(buy.json().portfolio.positions[0].quantity).toBe(0.05);
    expect(buy.json().portfolio.pendingSettlementPnl).toBe(-1.625);

    const price = await app.inject({
      method: "POST",
      url: "/examples/trading/market/BTC-USD/price",
      headers: adminHeaders,
      payload: { price: 67_000 },
    });
    expect(price.statusCode).toBe(200);

    const marked = await app.inject({
      method: "GET",
      url: `/portfolio/${alice}`,
    });
    expect(marked.json().positions[0].unrealizedPnl).toBe(100);

    const sell = await postSignedOrder({
      side: "SELL",
      quantity: 0.05,
      clientOrderId: "sell-1",
    });

    expect(sell.statusCode).toBe(200);
    expect(sell.json().trade.realizedPnlDelta).toBe(100);
    expect(sell.json().portfolio.pendingSettlementPnl).toBe(96.7);

    const settlement = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: adminHeaders,
      payload: genericSettlementRequest({
        userAddress: alice,
        appId: "trading-example",
        settlementType: "TRADING_PNL",
        amountDelta: "96.7",
        referenceIds: sell
          .json()
          .portfolio.trades.map((trade: { tradeId: string }) => trade.tradeId),
        metadata: { source: "api-test" },
      }),
    });
    expect(settlement.statusCode).toBe(409);
    expect(settlement.json().error.code).toBe("CONTRACT_DEPLOYMENT_NOT_READY");
  });

  it("rejects invalid signature", async () => {
    const payload = await signedOrderPayload({
      clientOrderId: "invalid-signature-1",
    });
    payload.signature = "0x12";

    const response = await app.inject({
      method: "POST",
      url: "/examples/trading/orders",
      payload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INVALID_INTENT_SIGNATURE");
  });

  it("rejects wrong signer", async () => {
    const payload = await signedOrderPayload(
      { clientOrderId: "wrong-signer-1" },
      bobAccount,
      alice,
    );

    const response = await app.inject({
      method: "POST",
      url: "/examples/trading/orders",
      payload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("WRONG_INTENT_SIGNER");
  });

  it("rejects expired deadline", async () => {
    const payload = await signedOrderPayload({
      clientOrderId: "expired-1",
      deadline: 1,
    });

    const response = await app.inject({
      method: "POST",
      url: "/examples/trading/orders",
      payload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INTENT_EXPIRED");
  });

  it("rejects reused nonce", async () => {
    const payload = await signedOrderPayload({
      clientOrderId: "reuse-nonce-1",
    });

    const first = await app.inject({
      method: "POST",
      url: "/examples/trading/orders",
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/examples/trading/orders",
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("INTENT_NONCE_ALREADY_USED");
  });

  it("rejects duplicate clientOrderId even when the nonce is fresh", async () => {
    const first = await postSignedOrder({ clientOrderId: "duplicate-1" });
    expect(first.statusCode).toBe(200);

    const second = await postSignedOrder({ clientOrderId: "duplicate-1" });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("DUPLICATE_CLIENT_ORDER_ID");
  });

  it("rejects invalid request bodies and insufficient collateral", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/examples/trading/orders",
      payload: {
        userAddress: "alice",
        symbol: "BTC-USD",
        side: "BUY",
        quantity: 1,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const insufficient = await postSignedOrder(
      { quantity: 1, clientOrderId: "buy-insufficient-1" },
      bobAccount,
      bob,
    );
    expect(insufficient.statusCode).toBe(409);
    expect(insufficient.json().error.code).toBe("INSUFFICIENT_COLLATERAL");
  });

  it("rejects withdrawal approval while a position is open", async () => {
    const buy = await postSignedOrder({
      side: "BUY",
      quantity: 0.05,
      clientOrderId: "withdraw-guard-buy-1",
    });
    expect(buy.statusCode).toBe(200);

    const approval = await app.inject({
      method: "POST",
      url: `/withdrawals/approve/${alice}`,
      headers: adminHeaders,
      payload: { amount: 100 },
    });

    expect(approval.statusCode).toBe(409);
    expect(approval.json().error.code).toBe("OPEN_POSITION_EXISTS");
  });

  it("requires a verified user-signed withdrawal intent before requesting withdrawal", async () => {
    const missingIntent = await app.inject({
      method: "POST",
      url: "/withdrawals/request",
      payload: { userAddress: alice, amount: 100 },
    });
    expect(missingIntent.statusCode).toBe(400);

    const unknownIntent = await app.inject({
      method: "POST",
      url: "/withdrawals/request",
      payload: {
        userAddress: alice,
        amount: 100,
        signedIntentId: "intent_missing",
      },
    });
    expect(unknownIntent.statusCode).toBe(409);
    expect(unknownIntent.json().error.code).toBe("WITHDRAWAL_INTENT_NOT_FOUND");

    const wrongType = await verifyGenericIntent({
      appId: "collateral-gateway",
      intentType: "APPLICATION_ACTION",
    });
    const wrongTypeRequest = await app.inject({
      method: "POST",
      url: "/withdrawals/request",
      payload: {
        userAddress: alice,
        amount: 100,
        signedIntentId: wrongType.intentId,
      },
    });
    expect(wrongTypeRequest.statusCode).toBe(409);
    expect(wrongTypeRequest.json().error.code).toBe(
      "WITHDRAWAL_INTENT_TYPE_MISMATCH",
    );

    const wrongUser = await verifyGenericIntent(
      {
        userAddress: bob,
        appId: "collateral-gateway",
        intentType: "WITHDRAWAL_REQUEST",
      },
      bobAccount,
    );
    const wrongUserRequest = await app.inject({
      method: "POST",
      url: "/withdrawals/request",
      payload: {
        userAddress: alice,
        amount: 100,
        signedIntentId: wrongUser.intentId,
      },
    });
    expect(wrongUserRequest.statusCode).toBe(409);
    expect(wrongUserRequest.json().error.code).toBe(
      "WITHDRAWAL_INTENT_USER_MISMATCH",
    );
  });

  it("rejects withdrawal approval while realized P&L is pending settlement", async () => {
    const buy = await postSignedOrder({
      side: "BUY",
      quantity: 0.05,
      clientOrderId: "withdraw-pnl-buy-1",
    });
    expect(buy.statusCode).toBe(200);

    const price = await app.inject({
      method: "POST",
      url: "/examples/trading/market/BTC-USD/price",
      headers: adminHeaders,
      payload: { price: 67_000 },
    });
    expect(price.statusCode).toBe(200);

    const sell = await postSignedOrder({
      side: "SELL",
      quantity: 0.05,
      clientOrderId: "withdraw-pnl-sell-1",
    });
    expect(sell.statusCode).toBe(200);
    expect(sell.json().portfolio.pendingSettlementPnl).toBe(96.7);

    const approval = await app.inject({
      method: "POST",
      url: `/withdrawals/approve/${alice}`,
      headers: adminHeaders,
      payload: { amount: 100 },
    });

    expect(approval.statusCode).toBe(409);
    expect(approval.json().error.code).toBe("PENDING_SETTLEMENT_PNL");
  });

  it("rejects zero generic settlement amount", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/settlements",
      headers: adminHeaders,
      payload: genericSettlementRequest({ amountDelta: "0" }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("ZERO_SETTLEMENT_AMOUNT");
  });
});

async function postSignedOrder(
  overrides: Partial<SignedOrderPayload> = {},
  signer: TestSigner = aliceAccount,
  userAddress: HexAddress = alice,
) {
  const payload = await signedOrderPayload(overrides, signer, userAddress);
  return app.inject({
    method: "POST",
    url: "/examples/trading/orders",
    payload,
  });
}

async function signedOrderPayload(
  overrides: Partial<SignedOrderPayload> = {},
  signer: TestSigner = aliceAccount,
  userAddress: HexAddress = alice,
) {
  const targetUser = overrides.userAddress ?? userAddress;
  const nonceResponse = await app.inject({
    method: "GET",
    url: `/auth/nonce/${targetUser}`,
  });
  expect(nonceResponse.statusCode).toBe(200);

  const order = {
    userAddress: targetUser,
    symbol: overrides.symbol ?? "BTC-USD",
    side: overrides.side ?? "BUY",
    type: "MARKET" as const,
    quantity: overrides.quantity ?? 0.01,
    clientOrderId:
      overrides.clientOrderId ?? `order-${Date.now()}-${Math.random()}`,
  };
  const intent = buildTradingOrderIntent({
    order,
    nonce: overrides.nonce ?? nonceResponse.json().nonce,
    deadline: overrides.deadline ?? Math.floor(Date.now() / 1000) + 60,
  });
  const signature = await signer.signTypedData(
    buildSignedIntentTypedData({
      chainId: 31337,
      verifyingContract: zeroAddress,
      intent,
    }),
  );

  return { order, intent, signature };
}

async function genericIntentPayload(
  overrides: Partial<SignedIntent> = {},
  signer: TestSigner = aliceAccount,
) {
  const targetUser = overrides.userAddress ?? alice;
  const nonceResponse = await app.inject({
    method: "GET",
    url: `/auth/nonce/${targetUser}`,
  });
  expect(nonceResponse.statusCode).toBe(200);

  const intent: SignedIntent = {
    userAddress: targetUser,
    appId: "fantasy-trading-app",
    intentType: "APPLICATION_ACTION",
    payloadHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    nonce: nonceResponse.json().nonce,
    deadline: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
  const signature = await signer.signTypedData(
    buildSignedIntentTypedData({
      chainId: 31337,
      verifyingContract: zeroAddress,
      intent,
    }),
  );

  return { intent, signature };
}

async function verifyGenericIntent(
  overrides: Partial<SignedIntent> = {},
  signer: TestSigner = aliceAccount,
) {
  const payload = await genericIntentPayload(overrides, signer);
  const response = await app.inject({
    method: "POST",
    url: "/intents/verify",
    payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { intentId: string };
}

function genericSettlementRequest(
  overrides: Partial<{
    userAddress: HexAddress;
    appId: string;
    settlementType: string;
    amountDelta: string;
    reasonHash: `0x${string}`;
    referenceIds: string[];
    signedIntentIds: string[];
    metadata: Record<string, unknown>;
  }> = {},
) {
  return {
    userAddress: overrides.userAddress ?? alice,
    appId: overrides.appId ?? "generic-test-app",
    settlementType: overrides.settlementType ?? "REWARD_ADJUSTMENT",
    amountDelta: overrides.amountDelta ?? "1.5",
    reasonHash: overrides.reasonHash ?? "0x".padEnd(66, "1"),
    referenceIds: overrides.referenceIds ?? ["ref-1"],
    signedIntentIds: overrides.signedIntentIds ?? [],
    ...(overrides.metadata === undefined
      ? {}
      : { metadata: overrides.metadata }),
  };
}
