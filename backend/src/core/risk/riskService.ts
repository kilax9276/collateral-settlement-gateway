import type { AppConfig } from "../../config.js";
import type {
  HexAddress,
  OrderRequest,
  Position,
  Quote,
} from "../../types/domain.js";
import { badRequest, conflict } from "../../utils/errors.js";
import { calculateNotional, roundMoney } from "../money/money.js";
import type { Ledger, UserLedgerState } from "../storage/gatewayLedger.js";
import type { MarketDataService } from "../../examples/trading/marketData.js";

export type OrderRiskInput = {
  request: OrderRequest;
  quote: Quote;
  proposedPosition: Position;
  pendingSettlementDelta: number;
};

export class RiskService {
  constructor(
    private readonly ledger: Ledger,
    private readonly marketData: MarketDataService,
    private readonly appConfig: AppConfig,
  ) {}

  checkOrderAllowed(input: OrderRiskInput): void {
    this.checkSupportedSymbol(input.request.symbol);
    this.checkPriceFreshness(input.quote);
    this.checkMaxPositionNotional(input.proposedPosition, input.quote.price);
    this.checkSufficientCollateral(input);
  }

  checkSufficientCollateral(input: OrderRiskInput): void {
    const state = this.ledger.getOrCreate(input.request.userAddress);

    if (state.collateral < this.appConfig.minCollateral) {
      throw conflict(
        "MIN_COLLATERAL_REQUIRED",
        `User collateral ${state.collateral} is below minimum required collateral ${this.appConfig.minCollateral}`,
      );
    }

    const simulated = this.simulatePortfolio(
      state,
      input.proposedPosition,
      input.pendingSettlementDelta,
    );
    if (simulated.freeCollateral < 0) {
      throw conflict(
        "INSUFFICIENT_COLLATERAL",
        `Insufficient free collateral after order. Free collateral would be ${simulated.freeCollateral}`,
      );
    }
  }

  checkMaxPositionNotional(position: Position, price: number): void {
    const positionNotional = calculateNotional(
      Math.abs(position.quantity),
      price,
    );
    if (positionNotional > this.appConfig.maxPositionNotional) {
      throw conflict(
        "MAX_POSITION_NOTIONAL_EXCEEDED",
        `Position notional ${positionNotional} exceeds maxPositionNotional ${this.appConfig.maxPositionNotional}`,
      );
    }
  }

  checkPriceFreshness(quote: Quote): void {
    const quoteTime = Date.parse(quote.timestamp ?? quote.ts);
    if (!Number.isFinite(quoteTime)) {
      throw conflict(
        "STALE_PRICE",
        `Quote for ${quote.symbol} has an invalid timestamp`,
      );
    }

    const ageMs = Date.now() - quoteTime;
    if (ageMs > this.appConfig.maxPriceAgeMs) {
      throw conflict(
        "STALE_PRICE",
        `Quote for ${quote.symbol} is stale. Age=${ageMs}ms, maxPriceAgeMs=${this.appConfig.maxPriceAgeMs}`,
      );
    }
  }

  checkWithdrawAllowed(userAddress: HexAddress, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest(
        "INVALID_WITHDRAW_AMOUNT",
        "Withdraw amount must be positive",
      );
    }

    const state = this.ledger.getOrCreate(userAddress);
    this.checkNoOpenPositionForWithdraw(state);
    this.checkNoPendingSettlement(state);

    if (state.collateral < amount) {
      throw conflict(
        "INSUFFICIENT_COLLATERAL",
        "Withdraw amount exceeds indexed collateral",
      );
    }

    if (state.pendingWithdrawals < amount) {
      throw conflict(
        "NO_PENDING_WITHDRAWAL",
        "Withdraw amount exceeds pending withdrawal request",
      );
    }
  }

  checkNoPendingSettlement(stateOrAddress: UserLedgerState | HexAddress): void {
    const state =
      typeof stateOrAddress === "string"
        ? this.ledger.getOrCreate(stateOrAddress)
        : stateOrAddress;
    if (Math.abs(state.pendingSettlementPnl) >= 0.000001) {
      throw conflict(
        "PENDING_SETTLEMENT_PNL",
        "Cannot approve withdrawal while realized P&L is waiting for on-chain settlement",
      );
    }
  }

  checkNoOpenPositionForWithdraw(
    stateOrAddress: UserLedgerState | HexAddress,
  ): void {
    const state =
      typeof stateOrAddress === "string"
        ? this.ledger.getOrCreate(stateOrAddress)
        : stateOrAddress;
    const hasOpenPosition = [...state.positions.values()].some(
      (position) => position.quantity !== 0,
    );
    if (hasOpenPosition) {
      throw conflict(
        "OPEN_POSITION_EXISTS",
        "Cannot approve withdrawal while the user has an open position",
      );
    }
  }

  private checkSupportedSymbol(symbol: string): void {
    const normalized = symbol.toUpperCase();
    if (!this.appConfig.supportedSymbols.includes(normalized)) {
      throw badRequest(
        "UNSUPPORTED_SYMBOL",
        `Unsupported trading symbol: ${symbol}`,
      );
    }
  }

  private simulatePortfolio(
    state: UserLedgerState,
    changedPosition: Position,
    pendingSettlementDelta: number,
  ) {
    const positions = new Map(state.positions);
    if (changedPosition.quantity === 0 && changedPosition.realizedPnl === 0) {
      positions.delete(changedPosition.symbol);
    } else {
      positions.set(changedPosition.symbol, changedPosition);
    }

    return this.ledger.snapshotState(
      {
        ...state,
        pendingSettlementPnl: roundMoney(
          state.pendingSettlementPnl + pendingSettlementDelta,
        ),
        positions,
        orders: [...state.orders],
        trades: [...state.trades],
        settlements: [...state.settlements],
      },
      (symbol) => this.marketData.getQuote(symbol).price,
      this.appConfig.maxLeverage,
    );
  }
}
