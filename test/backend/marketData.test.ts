import { describe, expect, it } from "vitest";
import { config } from "../../backend/src/config.js";
import { Ledger } from "../../backend/src/core/storage/gatewayLedger.js";
import { MarketDataService } from "../../backend/src/examples/trading/marketData.js";
import { RiskService } from "../../backend/src/core/risk/riskService.js";
import { TradingEngine } from "../../backend/src/examples/trading/tradingEngine.js";
import { AppError } from "../../backend/src/utils/errors.js";
import type { HexAddress } from "../../backend/src/types/domain.js";

const alice = "0x1000000000000000000000000000000000000001" as HexAddress;

describe("MarketDataService providers", () => {
  it("updates prices through the mock provider", async () => {
    const marketData = new MarketDataService("BTC-USD", 65_000);
    await marketData.start();

    const quote = marketData.setPrice("BTC-USD", 66_500);

    expect(quote).toMatchObject({
      symbol: "BTC-USD",
      price: 66_500,
      source: "mock",
    });
    expect(quote.timestamp).toBeTypeOf("string");
    expect(marketData.getQuote("BTC-USD").price).toBe(66_500);

    await marketData.stop();
  });

  it("lets RiskService reject stale quotes", () => {
    const appConfig = {
      ...config,
      maxPriceAgeMs: 1,
      storageDriver: "memory" as const,
    };
    const ledger = new Ledger();
    const marketData = new MarketDataService(
      appConfig.defaultSymbol,
      appConfig.defaultBtcPrice,
    );
    const riskService = new RiskService(ledger, marketData, appConfig);
    const engine = new TradingEngine(
      ledger,
      marketData,
      riskService,
      appConfig,
    );

    ledger.applyDeposit(alice, 10_000);
    marketData.setPrice(
      "BTC-USD",
      65_000,
      new Date(Date.now() - 10_000).toISOString(),
    );

    try {
      engine.placeOrder({
        userAddress: alice,
        symbol: "BTC-USD",
        side: "BUY",
        type: "MARKET",
        quantity: 0.01,
        clientOrderId: "stale-market-data-1",
      });
      throw new Error("Expected order to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("STALE_PRICE");
    }
  });
});
