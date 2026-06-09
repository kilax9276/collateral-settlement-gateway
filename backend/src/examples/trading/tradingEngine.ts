import { nanoid } from "nanoid";
import type { AppConfig } from "../../config.js";
import type {
  Order,
  OrderRequest,
  OrderResult,
  Position,
  Trade,
} from "../../types/domain.js";
import {
  calculateFee,
  calculateNotional,
  calculatePnl,
  calculateWeightedAveragePrice,
  decimalAdd,
  decimalSub,
  roundMoney,
} from "../../core/money/money.js";
import { badRequest, conflict } from "../../utils/errors.js";
import type { Ledger } from "../../core/storage/gatewayLedger.js";
import type { MarketDataService } from "./marketData.js";
import type { RiskService } from "../../core/risk/riskService.js";

export class TradingEngine {
  constructor(
    private readonly ledger: Ledger,
    private readonly marketData: MarketDataService,
    private readonly riskService: RiskService,
    private readonly appConfig: AppConfig,
  ) {}

  placeOrder(request: OrderRequest): OrderResult {
    const started = process.hrtime.bigint();
    this.validateOrder(request);
    this.ledger.assertUniqueClientOrderId(
      request.userAddress,
      request.clientOrderId,
    );

    const quote = this.marketData.getQuote(request.symbol);
    const price = quote.price;
    const quantity = roundMoney(request.quantity);
    const notional = calculateNotional(quantity, price);
    const fee = calculateFee(notional, this.appConfig.takerFeeBps);

    const state = this.ledger.getOrCreate(request.userAddress);
    const current =
      state.positions.get(quote.symbol) ?? emptyPosition(quote.symbol, price);
    const { position, realizedPnlDelta } = applyLongOnlyFill(
      current,
      request.side,
      quantity,
      price,
    );
    const pendingSettlementDelta = decimalSub(realizedPnlDelta, fee);

    this.riskService.checkOrderAllowed({
      request,
      quote,
      proposedPosition: position,
      pendingSettlementDelta,
    });

    const order: Order = {
      orderId: `ord_${nanoid(16)}`,
      clientOrderId: request.clientOrderId,
      userAddress: request.userAddress,
      symbol: quote.symbol,
      side: request.side,
      type: request.type,
      quantity,
      status: "FILLED",
      createdAt: new Date().toISOString(),
    };

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const trade: Trade = {
      tradeId: `trd_${nanoid(16)}`,
      orderId: order.orderId,
      clientOrderId: request.clientOrderId,
      userAddress: request.userAddress,
      symbol: quote.symbol,
      side: request.side,
      quantity,
      price,
      notional,
      fee,
      realizedPnlDelta: roundMoney(realizedPnlDelta),
      latencyMs: roundMoney(elapsedMs),
      ts: new Date().toISOString(),
    };

    this.ledger.setPosition(request.userAddress, position);
    this.ledger.addPendingSettlementPnl(
      request.userAddress,
      pendingSettlementDelta,
    );
    this.ledger.addOrder(order);
    this.ledger.addTrade(trade);

    const portfolio = this.ledger.snapshot(
      request.userAddress,
      (symbol) => this.marketData.getQuote(symbol).price,
      this.appConfig.maxLeverage,
    );

    return { order, trade, portfolio };
  }

  private validateOrder(request: OrderRequest): void {
    if (request.type !== "MARKET")
      throw badRequest(
        "UNSUPPORTED_ORDER_TYPE",
        "Reference trading example supports MARKET orders only",
      );
    if (!Number.isFinite(request.quantity) || request.quantity <= 0) {
      throw badRequest("INVALID_QUANTITY", "Order quantity must be positive");
    }
  }
}

function emptyPosition(symbol: string, markPrice: number): Position {
  return {
    symbol,
    quantity: 0,
    avgEntryPrice: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    markPrice,
  };
}

function applyLongOnlyFill(
  position: Position,
  side: "BUY" | "SELL",
  quantity: number,
  price: number,
): { position: Position; realizedPnlDelta: number } {
  if (side === "BUY") {
    const newQuantity = decimalAdd(position.quantity, quantity);
    const avgEntryPrice = calculateWeightedAveragePrice({
      existingQuantity: position.quantity,
      existingAvgPrice: position.avgEntryPrice,
      fillQuantity: quantity,
      fillPrice: price,
    });

    return {
      realizedPnlDelta: 0,
      position: {
        ...position,
        quantity: newQuantity,
        avgEntryPrice,
        markPrice: price,
        unrealizedPnl: calculatePnl(newQuantity, avgEntryPrice, price),
      },
    };
  }

  if (position.quantity <= 0) {
    throw conflict(
      "NO_LONG_POSITION",
      "Cannot sell because user has no open long position",
    );
  }

  if (quantity > position.quantity) {
    throw conflict(
      "LONG_ONLY_REFERENCE_EXAMPLE",
      "Reference trading example supports reducing/closing an existing long, not opening a short",
    );
  }

  const realizedPnlDelta = calculatePnl(
    quantity,
    position.avgEntryPrice,
    price,
  );
  const newQuantity = decimalSub(position.quantity, quantity);
  const avgEntryPrice = newQuantity === 0 ? 0 : position.avgEntryPrice;

  return {
    realizedPnlDelta,
    position: {
      ...position,
      quantity: newQuantity,
      avgEntryPrice,
      realizedPnl: decimalAdd(position.realizedPnl, realizedPnlDelta),
      markPrice: price,
      unrealizedPnl:
        newQuantity === 0 ? 0 : calculatePnl(newQuantity, avgEntryPrice, price),
    },
  };
}
