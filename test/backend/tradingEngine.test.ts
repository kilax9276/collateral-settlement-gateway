import { describe, expect, it } from "vitest";
import { config } from "../../backend/src/config.js";
import { AppError } from "../../backend/src/utils/errors.js";
import { Ledger } from "../../backend/src/core/storage/gatewayLedger.js";
import { MarketDataService } from "../../backend/src/examples/trading/marketData.js";
import { RiskService } from "../../backend/src/core/risk/riskService.js";
import { TradingEngine } from "../../backend/src/examples/trading/tradingEngine.js";
import type {
  HexAddress,
  OrderRequest,
} from "../../backend/src/types/domain.js";

const alice = "0x1000000000000000000000000000000000000001" as const;
const bob = "0x2000000000000000000000000000000000000002" as const;

function createHarness(
  seedCollateral = 10_000,
  overrides: Partial<typeof config> = {},
) {
  const appConfig = {
    ...config,
    defaultSymbol: "BTC-USD",
    defaultBtcPrice: 65_000,
    maxLeverage: 5,
    takerFeeBps: 5,
    ...overrides,
  };
  const ledger = new Ledger();
  const marketData = new MarketDataService(
    appConfig.defaultSymbol,
    appConfig.defaultBtcPrice,
  );
  const riskService = new RiskService(ledger, marketData, appConfig);
  const engine = new TradingEngine(ledger, marketData, riskService, appConfig);

  if (seedCollateral > 0) {
    ledger.applyDeposit(alice, seedCollateral);
  }

  return { appConfig, ledger, marketData, engine };
}

function marketOrder(
  userAddress: HexAddress,
  side: "BUY" | "SELL",
  quantity: number,
  clientOrderId: string,
): OrderRequest {
  return {
    userAddress,
    symbol: "BTC-USD",
    side,
    type: "MARKET",
    quantity,
    clientOrderId,
  };
}

describe("TradingEngine", () => {
  it("opens a BTC-USD long position with a market BUY and stores order/trade history", () => {
    const { engine } = createHarness();

    const result = engine.placeOrder(
      marketOrder(alice, "BUY", 0.1, "buy-open-1"),
    );

    expect(result.order.status).toBe("FILLED");
    expect(result.order.clientOrderId).toBe("buy-open-1");
    expect(result.trade.price).toBe(65_000);
    expect(result.trade.notional).toBe(6_500);
    expect(result.trade.fee).toBe(3.25);
    expect(result.trade.realizedPnlDelta).toBe(0);
    expect(result.trade.latencyMs).toBeLessThan(100);

    expect(result.portfolio.positions).toHaveLength(1);
    expect(result.portfolio.positions[0]).toMatchObject({
      symbol: "BTC-USD",
      quantity: 0.1,
      avgEntryPrice: 65_000,
      unrealizedPnl: 0,
    });
    expect(result.portfolio.pendingSettlementPnl).toBe(-3.25);
    expect(result.portfolio.orders).toHaveLength(1);
    expect(result.portfolio.trades).toHaveLength(1);
  });

  it("increases a long position and recalculates weighted average entry price", () => {
    const { engine, marketData } = createHarness();

    engine.placeOrder(marketOrder(alice, "BUY", 0.1, "buy-average-1"));
    marketData.setPrice("BTC-USD", 70_000);
    const result = engine.placeOrder(
      marketOrder(alice, "BUY", 0.1, "buy-average-2"),
    );

    expect(result.portfolio.positions[0]).toMatchObject({
      quantity: 0.2,
      avgEntryPrice: 67_500,
      markPrice: 70_000,
      unrealizedPnl: 500,
    });
    expect(result.portfolio.pendingSettlementPnl).toBe(-6.75);
    expect(result.portfolio.orders.map((order) => order.clientOrderId)).toEqual(
      ["buy-average-1", "buy-average-2"],
    );
    expect(result.portfolio.trades).toHaveLength(2);
  });

  it("partially closes a long position and realizes proportional P&L", () => {
    const { engine, marketData } = createHarness();

    engine.placeOrder(marketOrder(alice, "BUY", 0.1, "buy-partial-1"));
    marketData.setPrice("BTC-USD", 67_000);
    const result = engine.placeOrder(
      marketOrder(alice, "SELL", 0.04, "sell-partial-1"),
    );

    expect(result.trade.realizedPnlDelta).toBe(80);
    expect(result.trade.fee).toBe(1.34);
    expect(result.portfolio.positions[0]).toMatchObject({
      quantity: 0.06,
      avgEntryPrice: 65_000,
      realizedPnl: 80,
      markPrice: 67_000,
      unrealizedPnl: 120,
    });
    expect(result.portfolio.pendingSettlementPnl).toBe(75.41);
  });

  it("fully closes a long position and leaves realized P&L pending for settlement", () => {
    const { engine, marketData } = createHarness();

    engine.placeOrder(marketOrder(alice, "BUY", 0.05, "buy-close-1"));
    marketData.setPrice("BTC-USD", 67_000);
    const result = engine.placeOrder(
      marketOrder(alice, "SELL", 0.05, "sell-close-1"),
    );

    expect(result.trade.realizedPnlDelta).toBe(100);
    expect(result.portfolio.positions[0]).toMatchObject({
      quantity: 0,
      avgEntryPrice: 0,
      realizedPnl: 100,
      unrealizedPnl: 0,
    });
    expect(result.portfolio.pendingSettlementPnl).toBe(96.7);
    expect(result.portfolio.orders).toHaveLength(2);
    expect(result.portfolio.trades).toHaveLength(2);
  });

  it("marks unrealized P&L from the current BTC-USD price", () => {
    const { engine, ledger, marketData, appConfig } = createHarness();

    engine.placeOrder(marketOrder(alice, "BUY", 0.05, "buy-mark-1"));
    marketData.setPrice("BTC-USD", 63_000);
    const portfolio = ledger.snapshot(
      alice,
      (symbol) => marketData.getQuote(symbol).price,
      appConfig.maxLeverage,
    );

    expect(portfolio.positions[0]).toMatchObject({
      quantity: 0.05,
      avgEntryPrice: 65_000,
      markPrice: 63_000,
      unrealizedPnl: -100,
    });
    expect(portfolio.equity).toBe(9_898.375);
  });

  it("rejects orders when collateral is insufficient", () => {
    const { engine } = createHarness(0);

    try {
      engine.placeOrder(marketOrder(bob, "BUY", 1, "buy-too-large-1"));
      throw new Error("Expected order to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("INSUFFICIENT_COLLATERAL");
    }
  });

  it("rejects orders when max position notional would be exceeded", () => {
    const { engine } = createHarness(10_000, { maxPositionNotional: 1_000 });

    try {
      engine.placeOrder(marketOrder(alice, "BUY", 0.05, "buy-max-notional-1"));
      throw new Error("Expected order to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("MAX_POSITION_NOTIONAL_EXCEEDED");
    }
  });

  it("rejects orders when the market price is stale", () => {
    const { engine, marketData } = createHarness(10_000, { maxPriceAgeMs: 1 });
    marketData.setPrice(
      "BTC-USD",
      65_000,
      new Date(Date.now() - 10_000).toISOString(),
    );

    try {
      engine.placeOrder(marketOrder(alice, "BUY", 0.01, "buy-stale-price-1"));
      throw new Error("Expected order to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("STALE_PRICE");
    }
  });
});
