import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../backend/src/app.js";
import { config } from "../../backend/src/config.js";
import { Ledger } from "../../backend/src/core/storage/gatewayLedger.js";
import { MarketDataService } from "../../backend/src/examples/trading/marketData.js";
import { RiskService } from "../../backend/src/core/risk/riskService.js";
import { TradingEngine } from "../../backend/src/examples/trading/tradingEngine.js";
import { SqliteStorage } from "../../backend/src/core/storage/index.js";
import type { HexAddress } from "../../backend/src/types/domain.js";

const alice = "0x1000000000000000000000000000000000000001" as HexAddress;

describe("SQLite storage", () => {
  it("initializes the schema and restores balances, positions, orders and trades after restart", async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "collateral-settlement-gateway-sqlite-test-"),
    );
    const dbPath = join(tempDir, "app.db");

    try {
      const firstStorage = new SqliteStorage(dbPath);
      const firstLedger = new Ledger(firstStorage);
      const appConfig = {
        ...config,
        defaultSymbol: "BTC-USD",
        defaultBtcPrice: 65_000,
        maxLeverage: 5,
        takerFeeBps: 5,
        storageDriver: "sqlite" as const,
        sqlitePath: dbPath,
      };
      const marketData = new MarketDataService(
        appConfig.defaultSymbol,
        appConfig.defaultBtcPrice,
      );
      const riskService = new RiskService(firstLedger, marketData, appConfig);
      const engine = new TradingEngine(
        firstLedger,
        marketData,
        riskService,
        appConfig,
      );

      firstLedger.applyIndexedDeposit(alice, 10_000, "0xdeposit:0");
      const result = engine.placeOrder({
        userAddress: alice,
        symbol: "BTC-USD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.05,
        clientOrderId: "sqlite-buy-1",
      });
      expect(result.portfolio.positions[0].quantity).toBe(0.05);
      firstStorage.close();

      const secondStorage = new SqliteStorage(dbPath);
      const secondLedger = new Ledger(secondStorage);
      const restored = secondLedger.snapshot(alice, () => 65_000, 5);

      expect(restored.collateral).toBe(10_000);
      expect(restored.pendingSettlementPnl).toBe(-1.625);
      expect(restored.positions[0].quantity).toBe(0.05);
      expect(restored.orders.map((order) => order.clientOrderId)).toContain(
        "sqlite-buy-1",
      );
      expect(restored.trades).toHaveLength(1);

      secondStorage.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restores portfolio state after rebuilding the app with the same SQLite database", async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "collateral-settlement-gateway-app-restart-test-"),
    );
    const dbPath = join(tempDir, "app.db");

    try {
      const first = await buildApp(
        {
          ...config,
          host: "127.0.0.1",
          port: 0,
          storageDriver: "sqlite",
          sqlitePath: dbPath,
          defaultBtcPrice: 65_000,
          takerFeeBps: 5,
          maxLeverage: 5,
        },
        {
          logger: false,
          seedBalances: { [alice]: 10_000 },
          startIndexer: false,
        },
      );
      first.services.tradingEngine.placeOrder({
        userAddress: alice,
        symbol: "BTC-USD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.05,
        clientOrderId: "app-restart-buy-1",
      });
      await first.app.close();

      const second = await buildApp(
        {
          ...config,
          host: "127.0.0.1",
          port: 0,
          storageDriver: "sqlite",
          sqlitePath: dbPath,
          defaultBtcPrice: 65_000,
          takerFeeBps: 5,
          maxLeverage: 5,
        },
        { logger: false, startIndexer: false },
      );
      const response = await second.app.inject({
        method: "GET",
        url: `/portfolio/${alice}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().collateral).toBe(10_000);
      expect(response.json().positions[0].quantity).toBe(0.05);
      expect(response.json().orders[0].clientOrderId).toBe("app-restart-buy-1");
      await second.app.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists verified signed intents in SQLite", async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "collateral-settlement-gateway-intents-test-"),
    );
    const dbPath = join(tempDir, "app.db");

    try {
      const firstStorage = new SqliteStorage(dbPath);
      const firstLedger = new Ledger(firstStorage);
      const issued = firstLedger.issueIntentNonce(alice);
      firstLedger.consumeIntentNonce(alice, issued.nonce);
      const stored = firstLedger.recordVerifiedIntent({
        intent: {
          userAddress: alice,
          appId: "test-app",
          intentType: "APPLICATION_ACTION",
          payloadHash:
            "0x2222222222222222222222222222222222222222222222222222222222222222",
          nonce: issued.nonce,
          deadline: Math.floor(Date.now() / 1000) + 60,
        },
        signature: "0x1234",
        signer: alice,
        status: "VERIFIED",
      });
      firstStorage.close();

      const secondStorage = new SqliteStorage(dbPath);
      const restored = secondStorage.signedIntentsRepository.getIntentById(
        stored.id,
      );
      expect(restored).toMatchObject({
        id: stored.id,
        userAddress: alice.toLowerCase(),
        appId: "test-app",
        intentType: "APPLICATION_ACTION",
        nonce: issued.nonce,
        status: "VERIFIED",
      });
      secondStorage.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
