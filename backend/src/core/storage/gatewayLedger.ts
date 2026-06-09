import { nanoid } from "nanoid";
import type {
  HexAddress,
  HexString,
  IndexedChainEvent,
  NormalizedSettlementRequest,
  Order,
  Portfolio,
  Position,
  SettlementOnChainData,
  SettlementRecord,
  Trade,
} from "../../types/domain.js";
import {
  calculateMarginUsed,
  calculatePnl,
  decimalAdd,
  decimalSub,
  roundMoney,
} from "../money/money.js";
import { badRequest, conflict } from "../../utils/errors.js";
import type { AppStorage, StoredBalance, StoredSignedIntent } from "./index.js";
import { MemoryStorage } from "./index.js";

export type UserLedgerState = {
  userAddress: HexAddress;
  collateral: number;
  pendingSettlementPnl: number;
  pendingWithdrawals: number;
  approvedWithdrawals: number;
  positions: Map<string, Position>;
  orders: Order[];
  trades: Trade[];
  settlements: SettlementRecord[];
  settlementInFlight?: {
    amountDelta: number;
    settlementId: HexString;
    reasonHash: HexString;
    appId: string;
    settlementType: string;
    referenceIds: string[];
    signedIntentIds: string[];
    metadata?: Record<string, unknown>;
    txHash?: string;
    onChain?: SettlementOnChainData;
  };
};

export class Ledger {
  private readonly users = new Map<string, UserLedgerState>();
  private readonly processedIndexedEvents = new Set<string>();

  constructor(private readonly storage: AppStorage = new MemoryStorage()) {}

  getOrCreate(userAddress: HexAddress): UserLedgerState {
    const normalized = normalizeAddress(userAddress);
    let state = this.users.get(normalized);
    if (state) return state;

    this.storage.ledgerRepository.ensureUser(normalized);
    const storedBalance = this.storage.ledgerRepository.getBalance(normalized);
    state = {
      userAddress: normalized,
      collateral: roundMoney(storedBalance?.collateral ?? 0),
      pendingSettlementPnl: roundMoney(
        storedBalance?.pendingSettlementPnl ?? 0,
      ),
      pendingWithdrawals: roundMoney(storedBalance?.pendingWithdrawals ?? 0),
      approvedWithdrawals: roundMoney(storedBalance?.approvedWithdrawals ?? 0),
      positions: new Map(
        this.storage.positionsRepository
          .listPositions(normalized)
          .map((position) => [position.symbol.toUpperCase(), position]),
      ),
      orders: this.storage.ordersRepository.listOrders(normalized),
      trades: this.storage.tradesRepository.listTrades(normalized),
      settlements:
        this.storage.settlementRepository.listSettlements(normalized),
    };
    this.users.set(normalized, state);

    if (!storedBalance) this.saveBalance(state);
    return state;
  }

  listKnownUsers(): HexAddress[] {
    const users = new Set<string>([
      ...this.storage.ledgerRepository.listUsers(),
      ...this.users.keys(),
    ]);
    return [...users].sort() as HexAddress[];
  }

  issueIntentNonce(userAddress: HexAddress): {
    userAddress: HexAddress;
    nonce: string;
    issuedAt: string;
  } {
    const normalized = normalizeAddress(userAddress);
    this.getOrCreate(normalized);
    const nonce = `intentnonce_${nanoid(24)}`;
    const issuedAt = new Date().toISOString();
    this.storage.signedIntentsRepository.issueNonce(
      normalized,
      nonce,
      issuedAt,
    );

    return { userAddress: normalized, nonce, issuedAt };
  }

  consumeIntentNonce(userAddress: HexAddress, nonce: string): void {
    const normalized = normalizeAddress(userAddress);
    const stored = this.storage.signedIntentsRepository.getNonce(
      normalized,
      nonce,
    );
    if (!stored) {
      throw conflict(
        "INVALID_INTENT_NONCE",
        "Intent nonce was not issued by this backend",
      );
    }

    if (stored.status === "USED") {
      throw conflict(
        "INTENT_NONCE_ALREADY_USED",
        "Intent nonce was already used",
      );
    }

    this.storage.signedIntentsRepository.markNonceUsed(
      normalized,
      nonce,
      new Date().toISOString(),
    );
  }

  recordVerifiedIntent(input: {
    intent: {
      userAddress: HexAddress;
      appId: string;
      intentType: string;
      payloadHash: HexString;
      nonce: string;
      deadline: number;
    };
    signature: HexString;
    signer: HexAddress;
    status: "VERIFIED";
  }): StoredSignedIntent {
    const createdAt = new Date().toISOString();
    return this.storage.signedIntentsRepository.recordVerifiedIntent({
      id: `intent_${nanoid(24)}`,
      userAddress: normalizeAddress(input.intent.userAddress),
      appId: input.intent.appId,
      intentType: input.intent.intentType,
      payloadHash: input.intent.payloadHash,
      nonce: input.intent.nonce,
      deadline: input.intent.deadline,
      signature: input.signature,
      signer: normalizeAddress(input.signer),
      status: input.status,
      createdAt,
    });
  }

  listVerifiedSignedIntents(userAddress: HexAddress): StoredSignedIntent[] {
    return this.storage.signedIntentsRepository.listIntents(
      normalizeAddress(userAddress),
    );
  }

  getSignedIntentById(id: string): StoredSignedIntent | null {
    return this.storage.signedIntentsRepository.getIntentById(id);
  }

  consumeSignedIntents(
    settlementId: HexString,
    signedIntentIds: string[],
  ): void {
    const consumedAt = new Date().toISOString();
    for (const signedIntentId of signedIntentIds) {
      this.storage.signedIntentsRepository.markIntentConsumed(
        signedIntentId,
        settlementId,
        consumedAt,
      );
    }
  }

  expireSignedIntent(id: string): void {
    this.storage.signedIntentsRepository.markIntentExpired(
      id,
      new Date().toISOString(),
    );
  }

  issueOrderNonce(userAddress: HexAddress): {
    userAddress: HexAddress;
    nonce: string;
    issuedAt: string;
  } {
    return this.issueIntentNonce(userAddress);
  }

  consumeOrderNonce(userAddress: HexAddress, nonce: string): void {
    this.consumeIntentNonce(userAddress, nonce);
  }

  applyDeposit(userAddress: HexAddress, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest(
        "INVALID_DEPOSIT_AMOUNT",
        "Deposit amount must be positive",
      );
    }
    this.applyIndexedDeposit(userAddress, amount);
  }

  applyIndexedDeposit(
    userAddress: HexAddress,
    amount: number,
    eventId?: string,
  ): void {
    if (!this.claimIndexedEvent(eventId)) return;
    const state = this.getOrCreate(userAddress);
    state.collateral = decimalAdd(state.collateral, amount);
    this.saveBalance(state);
  }

  applyIndexedWithdrawRequest(
    userAddress: HexAddress,
    amount: number,
    eventId?: string,
  ): void {
    if (!this.claimIndexedEvent(eventId)) return;
    const state = this.getOrCreate(userAddress);
    state.pendingWithdrawals = decimalAdd(state.pendingWithdrawals, amount);
    this.saveBalance(state);
  }

  applyIndexedWithdrawApproval(
    userAddress: HexAddress,
    amount: number,
    eventId?: string,
  ): void {
    if (!this.claimIndexedEvent(eventId)) return;
    const state = this.getOrCreate(userAddress);
    state.pendingWithdrawals = roundMoney(
      Math.max(0, state.pendingWithdrawals - amount),
    );
    state.approvedWithdrawals = decimalAdd(state.approvedWithdrawals, amount);
    this.saveBalance(state);
  }

  applyIndexedWithdraw(
    userAddress: HexAddress,
    amount: number,
    eventId?: string,
  ): void {
    if (!this.claimIndexedEvent(eventId)) return;
    const state = this.getOrCreate(userAddress);
    state.collateral = Math.max(0, decimalSub(state.collateral, amount));
    state.approvedWithdrawals = roundMoney(
      Math.max(0, decimalSub(state.approvedWithdrawals, amount)),
    );
    this.saveBalance(state);
  }

  beginOnchainSettlement(
    userAddress: HexAddress,
    request: NormalizedSettlementRequest,
    settlementId: HexString,
  ): void {
    const state = this.getOrCreate(userAddress);
    if (state.settlementInFlight) {
      throw conflict(
        "SETTLEMENT_ALREADY_IN_FLIGHT",
        `Settlement is already in flight for this user: ${state.settlementInFlight.txHash ?? "tx pending"}`,
      );
    }
    state.settlementInFlight = {
      amountDelta: roundMoney(request.amountDelta),
      settlementId,
      reasonHash: request.reasonHash,
      appId: request.appId,
      settlementType: request.settlementType,
      referenceIds: [...request.referenceIds],
      signedIntentIds: [...request.signedIntentIds],
      metadata: request.metadata,
    };
  }

  recordOnchainSettlementSubmitted(
    userAddress: HexAddress,
    request: NormalizedSettlementRequest,
    txHash: string,
    settlementId: HexString,
    onChain?: Partial<SettlementOnChainData>,
  ): SettlementRecord {
    const state = this.getOrCreate(userAddress);
    const existing = state.settlements.find(
      (settlement) =>
        settlement.txHash === txHash ||
        settlement.settlementId === settlementId,
    );
    if (existing) return existing;

    state.settlementInFlight = {
      amountDelta: roundMoney(request.amountDelta),
      settlementId,
      reasonHash: request.reasonHash,
      appId: request.appId,
      settlementType: request.settlementType,
      referenceIds: [...request.referenceIds],
      signedIntentIds: [...request.signedIntentIds],
      metadata: request.metadata,
      txHash,
      onChain: mergeOnChainData(txHash, undefined, onChain),
    };

    const submitted = makeSettlementRecord({
      settlementId,
      reasonHash: request.reasonHash,
      userAddress,
      appId: request.appId,
      settlementType: request.settlementType,
      amountDelta: request.amountDelta,
      referenceIds: request.referenceIds,
      signedIntentIds: request.signedIntentIds,
      metadata: request.metadata,
      status: "ONCHAIN_SUBMITTED",
      txHash,
      onChain: mergeOnChainData(txHash, undefined, onChain),
    });
    state.settlements.push(submitted);
    this.storage.settlementRepository.upsertSettlement(submitted);
    return submitted;
  }

  applyIndexedSettlement(
    userAddress: HexAddress,
    amountDelta: number,
    newBalance: number,
    txHash: string,
    eventId?: string,
    settlementId?: HexString,
    reasonHash?: HexString,
    onChain?: Partial<SettlementOnChainData>,
  ): SettlementRecord {
    if (!this.claimIndexedEvent(eventId)) {
      const existing = this.getOrCreate(userAddress).settlements.find(
        (settlement) =>
          settlement.txHash === txHash ||
          settlement.settlementId === settlementId,
      );
      if (existing) return existing;
    }

    const state = this.getOrCreate(userAddress);
    const normalizedSettlementId =
      settlementId ?? state.settlementInFlight?.settlementId;
    const normalizedReasonHash =
      reasonHash ?? state.settlementInFlight?.reasonHash;
    if (!normalizedSettlementId || !normalizedReasonHash) {
      throw conflict(
        "SETTLEMENT_AUDIT_DATA_MISSING",
        "Settlement event does not include settlementId/reasonHash and no in-flight audit data exists",
      );
    }

    const existing = state.settlements.find(
      (settlement) =>
        settlement.txHash === txHash ||
        settlement.settlementId === normalizedSettlementId,
    );

    if (existing?.status === "ONCHAIN_CONFIRMED") {
      return existing;
    }

    state.collateral = roundMoney(newBalance);

    const context = existing ?? state.settlementInFlight;
    const settlementType = context?.settlementType ?? "GENERIC";
    if (settlementType === "TRADING_PNL") {
      state.pendingSettlementPnl = roundMoney(
        decimalSub(state.pendingSettlementPnl, amountDelta),
      );
      if (Math.abs(state.pendingSettlementPnl) < 0.000001)
        state.pendingSettlementPnl = 0;
    }

    if (
      state.settlementInFlight?.txHash === txHash ||
      state.settlementInFlight?.settlementId === normalizedSettlementId ||
      state.settlementInFlight?.amountDelta === roundMoney(amountDelta)
    ) {
      state.settlementInFlight = undefined;
    }

    if (existing) {
      existing.status = "ONCHAIN_CONFIRMED";
      existing.amountDelta = roundMoney(amountDelta);
      existing.pnl = roundMoney(amountDelta);
      existing.reasonHash = normalizedReasonHash;
      existing.txHash = txHash;
      existing.onChain = mergeOnChainData(txHash, existing.onChain, onChain);
      existing.signedIntentIds =
        context?.signedIntentIds ?? existing.signedIntentIds;
      existing.confirmedAt = new Date().toISOString();
      existing.ts = existing.confirmedAt;
      this.saveBalance(state);
      this.storage.settlementRepository.upsertSettlement(existing);
      return existing;
    }

    const confirmed = makeSettlementRecord({
      settlementId: normalizedSettlementId,
      reasonHash: normalizedReasonHash,
      userAddress,
      appId: context?.appId ?? "unknown-app",
      settlementType: context?.settlementType ?? "GENERIC",
      amountDelta,
      referenceIds: context?.referenceIds ?? [],
      signedIntentIds: context?.signedIntentIds ?? [],
      metadata: context?.metadata,
      status: "ONCHAIN_CONFIRMED",
      txHash,
      onChain: mergeOnChainData(txHash, context?.onChain, onChain),
    });
    state.settlements.push(confirmed);
    this.saveBalance(state);
    this.storage.settlementRepository.upsertSettlement(confirmed);
    return confirmed;
  }

  applyIndexedPnlSettlement(
    userAddress: HexAddress,
    pnl: number,
    newBalance: number,
    txHash: string,
    eventId?: string,
    settlementId?: HexString,
    reasonHash?: HexString,
    onChain?: Partial<SettlementOnChainData>,
  ): SettlementRecord {
    return this.applyIndexedSettlement(
      userAddress,
      pnl,
      newBalance,
      txHash,
      eventId,
      settlementId,
      reasonHash,
      onChain,
    );
  }

  clearOnchainSettlementInFlight(userAddress: HexAddress): void {
    const state = this.getOrCreate(userAddress);
    state.settlementInFlight = undefined;
  }

  applyWithdraw(userAddress: HexAddress, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest(
        "INVALID_WITHDRAW_AMOUNT",
        "Withdraw amount must be positive",
      );
    }
    const state = this.getOrCreate(userAddress);
    if (state.approvedWithdrawals < amount) {
      throw conflict(
        "WITHDRAWAL_NOT_APPROVED",
        "Withdraw amount exceeds approved withdrawal",
      );
    }
    if (state.collateral < amount) {
      throw conflict(
        "INSUFFICIENT_COLLATERAL",
        "Withdraw amount exceeds indexed collateral",
      );
    }
    state.collateral = decimalSub(state.collateral, amount);
    state.approvedWithdrawals = decimalSub(state.approvedWithdrawals, amount);
    this.saveBalance(state);
  }

  assertWithdrawalRequestAllowed(
    userAddress: HexAddress,
    amount: number,
  ): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest(
        "INVALID_WITHDRAW_AMOUNT",
        "Withdraw amount must be positive",
      );
    }

    const state = this.getOrCreate(userAddress);
    const reserved = state.pendingWithdrawals + state.approvedWithdrawals;
    const availableForRequest = decimalSub(state.collateral, reserved);
    if (availableForRequest < amount) {
      throw conflict(
        "INSUFFICIENT_COLLATERAL",
        `Requested withdrawal exceeds collateral not already pending or approved. Available=${availableForRequest}`,
      );
    }
  }

  assertWithdrawalApprovalAllowed(
    userAddress: HexAddress,
    amount: number,
  ): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest(
        "INVALID_WITHDRAW_AMOUNT",
        "Withdraw amount must be positive",
      );
    }

    const state = this.getOrCreate(userAddress);
    const hasOpenPosition = [...state.positions.values()].some(
      (position) => position.quantity !== 0,
    );
    if (hasOpenPosition) {
      throw conflict(
        "OPEN_POSITION_EXISTS",
        "Cannot approve withdrawal while the user has an open position",
      );
    }

    if (Math.abs(state.pendingSettlementPnl) >= 0.000001) {
      throw conflict(
        "PENDING_SETTLEMENT_PNL",
        "Cannot approve withdrawal while realized P&L is waiting for on-chain settlement",
      );
    }

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

  getPosition(userAddress: HexAddress, symbol: string): Position | undefined {
    return this.getOrCreate(userAddress).positions.get(symbol.toUpperCase());
  }

  setPosition(userAddress: HexAddress, position: Position): void {
    const state = this.getOrCreate(userAddress);
    if (position.quantity === 0 && position.realizedPnl === 0) {
      state.positions.delete(position.symbol);
      this.storage.positionsRepository.deletePosition(
        state.userAddress,
        position.symbol,
      );
      return;
    }
    state.positions.set(position.symbol, position);
    this.storage.positionsRepository.upsertPosition(
      state.userAddress,
      position,
      new Date().toISOString(),
    );
  }

  addPendingSettlementPnl(userAddress: HexAddress, pnlDelta: number): void {
    const state = this.getOrCreate(userAddress);
    state.pendingSettlementPnl = roundMoney(
      decimalAdd(state.pendingSettlementPnl, pnlDelta),
    );
    this.saveBalance(state);
  }

  applyMockSettlement(record: SettlementRecord): void {
    const state = this.getOrCreate(record.userAddress);
    if (
      record.settlementType === "TRADING_PNL" &&
      roundMoney(state.pendingSettlementPnl) !== roundMoney(record.amountDelta)
    ) {
      throw conflict(
        "SETTLEMENT_PNL_CHANGED",
        "Pending settlement P&L changed before mock confirmation",
      );
    }
    state.collateral = decimalAdd(state.collateral, record.amountDelta);
    if (record.settlementType === "TRADING_PNL") state.pendingSettlementPnl = 0;
    state.settlements.push(record);
    this.saveBalance(state);
    this.storage.settlementRepository.upsertSettlement(record);
  }

  addOrder(order: Order): void {
    const state = this.getOrCreate(order.userAddress);
    if (!state.orders.some((existing) => existing.orderId === order.orderId)) {
      state.orders.push(order);
    }
    this.storage.ordersRepository.addOrder(order);
    this.storage.ordersRepository.addIdempotencyKey(
      order.clientOrderId,
      state.userAddress,
      order.createdAt,
    );
  }

  addTrade(trade: Trade): void {
    const state = this.getOrCreate(trade.userAddress);
    if (!state.trades.some((existing) => existing.tradeId === trade.tradeId)) {
      state.trades.push(trade);
    }
    this.storage.tradesRepository.addTrade(trade);
  }

  assertUniqueClientOrderId(
    userAddress: HexAddress,
    clientOrderId: string,
  ): void {
    const state = this.getOrCreate(userAddress);
    const duplicate =
      state.orders.some((order) => order.clientOrderId === clientOrderId) ||
      this.storage.ordersRepository.hasClientOrderId(
        state.userAddress,
        clientOrderId,
      ) ||
      this.storage.ordersRepository.hasIdempotencyKey(
        clientOrderId,
        state.userAddress,
      );
    if (duplicate) {
      throw conflict(
        "DUPLICATE_CLIENT_ORDER_ID",
        "Order with this clientOrderId was already accepted",
      );
    }
  }

  getIndexerCursor(chainId: number, contractAddress: string): string | null {
    return (
      this.storage.chainEventsRepository.getCursor(chainId, contractAddress)
        ?.lastProcessedBlock ?? null
    );
  }

  saveIndexerCursor(
    chainId: number,
    contractAddress: string,
    lastProcessedBlock: string,
  ): void {
    this.storage.chainEventsRepository.saveCursor({
      chainId,
      contractAddress,
      lastProcessedBlock,
    });
  }

  recordIndexedChainEvent(event: IndexedChainEvent): boolean {
    if (this.processedIndexedEvents.has(event.eventId)) return false;
    const claimed = this.storage.chainEventsRepository.claimIndexedEvent(event);
    if (!claimed) {
      this.processedIndexedEvents.add(event.eventId);
      return false;
    }
    this.processedIndexedEvents.add(event.eventId);
    return true;
  }

  snapshot(
    userAddress: HexAddress,
    markPriceBySymbol: (symbol: string) => number,
    maxLeverage: number,
  ): Portfolio {
    const state = this.getOrCreate(userAddress);
    return this.snapshotState(state, markPriceBySymbol, maxLeverage);
  }

  snapshotState(
    state: UserLedgerState,
    markPriceBySymbol: (symbol: string) => number,
    maxLeverage: number,
  ): Portfolio {
    const positions = [...state.positions.values()]
      .map((position) => {
        const markPrice = markPriceBySymbol(position.symbol);
        const unrealizedPnl = calculatePnl(
          position.quantity,
          position.avgEntryPrice,
          markPrice,
        );
        return {
          ...position,
          markPrice,
          unrealizedPnl: roundMoney(unrealizedPnl),
        };
      })
      .filter(
        (position) => position.quantity !== 0 || position.realizedPnl !== 0,
      );

    const unrealized = positions.reduce(
      (sum, position) => decimalAdd(sum, position.unrealizedPnl),
      0,
    );
    const marginUsed = positions.reduce(
      (sum, position) =>
        decimalAdd(
          sum,
          calculateMarginUsed(
            position.quantity,
            position.markPrice,
            maxLeverage,
          ),
        ),
      0,
    );
    const equity = decimalAdd(
      decimalAdd(state.collateral, state.pendingSettlementPnl),
      unrealized,
    );

    return {
      userAddress: state.userAddress,
      collateral: roundMoney(state.collateral),
      equity: roundMoney(equity),
      marginUsed: roundMoney(marginUsed),
      freeCollateral: decimalSub(equity, marginUsed),
      pendingSettlementPnl: roundMoney(state.pendingSettlementPnl),
      pendingWithdrawals: roundMoney(state.pendingWithdrawals),
      approvedWithdrawals: roundMoney(state.approvedWithdrawals),
      positions,
      orders: [...state.orders],
      trades: [...state.trades],
      settlements: [...state.settlements],
      ts: new Date().toISOString(),
    };
  }

  private claimIndexedEvent(eventId?: string): boolean {
    if (!eventId) return true;
    if (this.processedIndexedEvents.has(eventId)) return false;
    if (this.storage.chainEventsRepository.hasIndexedEvent(eventId)) {
      this.processedIndexedEvents.add(eventId);
      return false;
    }
    this.processedIndexedEvents.add(eventId);
    return true;
  }

  private saveBalance(state: UserLedgerState): void {
    const balance: StoredBalance = {
      userAddress: state.userAddress,
      collateral: roundMoney(state.collateral),
      pendingSettlementPnl: roundMoney(state.pendingSettlementPnl),
      pendingWithdrawals: roundMoney(state.pendingWithdrawals),
      approvedWithdrawals: roundMoney(state.approvedWithdrawals),
      updatedAt: new Date().toISOString(),
    };
    this.storage.ledgerRepository.saveBalance(balance);
  }
}

function makeSettlementRecord(input: {
  settlementId: HexString;
  reasonHash: HexString;
  userAddress: HexAddress;
  appId: string;
  settlementType: string;
  amountDelta: number;
  referenceIds: string[];
  signedIntentIds: string[];
  metadata?: Record<string, unknown>;
  status: SettlementRecord["status"];
  txHash: string;
  onChain?: SettlementOnChainData;
}): SettlementRecord {
  const amountDelta = roundMoney(input.amountDelta);
  const now = new Date().toISOString();
  const onChain = input.onChain ?? mergeOnChainData(input.txHash);
  return {
    settlementId: input.settlementId,
    reasonHash: input.reasonHash,
    userAddress: normalizeAddress(input.userAddress),
    appId: input.appId,
    settlementType: input.settlementType,
    amountDelta,
    pnl: amountDelta,
    referenceIds: [...input.referenceIds],
    signedIntentIds: [...input.signedIntentIds],
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    status: input.status,
    txHash: input.txHash,
    onChain,
    createdAt: now,
    confirmedAt: input.status === "ONCHAIN_CONFIRMED" ? now : null,
    ts: input.status === "ONCHAIN_CONFIRMED" ? now : now,
  };
}

function mergeOnChainData(
  txHash: string,
  existing?: SettlementOnChainData,
  updates: Partial<SettlementOnChainData> = {},
): SettlementOnChainData {
  return {
    txHash,
    blockNumber: updates.blockNumber ?? existing?.blockNumber ?? null,
    eventName: updates.eventName ?? existing?.eventName ?? "SettlementApplied",
    contractAddress:
      updates.contractAddress ?? existing?.contractAddress ?? null,
  };
}

function normalizeAddress(userAddress: HexAddress): HexAddress {
  return userAddress.toLowerCase() as HexAddress;
}
