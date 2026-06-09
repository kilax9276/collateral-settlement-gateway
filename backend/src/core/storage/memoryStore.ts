import type {
  AppStorage,
  ChainEventsRepository,
  LedgerRepository,
  OrdersRepository,
  SignedIntentsRepository,
  PositionsRepository,
  SettlementRepository,
  StoredBalance,
  StoredChainEvent,
  StoredIndexerCursor,
  StoredNonce,
  StoredSignedIntent,
  TradesRepository,
} from "./types.js";
import type {
  HexAddress,
  IndexedChainEvent,
  Order,
  Position,
  SettlementRecord,
  Trade,
} from "../../types/domain.js";

export class MemoryStorage implements AppStorage {
  readonly kind = "memory" as const;
  readonly ledgerRepository = new MemoryLedgerRepository();
  readonly signedIntentsRepository = new MemorySignedIntentsRepository(
    this.ledgerRepository,
  );
  readonly ordersRepository = new MemoryOrdersRepository();
  readonly positionsRepository = new MemoryPositionsRepository();
  readonly tradesRepository = new MemoryTradesRepository();
  readonly settlementRepository = new MemorySettlementRepository();
  readonly chainEventsRepository = new MemoryChainEventsRepository();

  close(): void {
    // Nothing to close.
  }
}

class MemoryLedgerRepository implements LedgerRepository {
  private readonly users = new Set<string>();
  private readonly balances = new Map<string, StoredBalance>();

  ensureUser(userAddress: HexAddress): void {
    this.users.add(userAddress.toLowerCase());
  }

  listUsers(): HexAddress[] {
    return [...this.users].sort() as HexAddress[];
  }

  getBalance(userAddress: HexAddress): StoredBalance | null {
    return this.balances.get(userAddress.toLowerCase()) ?? null;
  }

  saveBalance(balance: StoredBalance): void {
    this.ensureUser(balance.userAddress);
    this.balances.set(balance.userAddress.toLowerCase(), { ...balance });
  }
}

class MemorySignedIntentsRepository implements SignedIntentsRepository {
  private readonly nonces = new Map<string, StoredNonce>();
  private readonly intentsById = new Map<string, StoredSignedIntent>();
  private readonly intentIdByNonce = new Map<string, string>();

  constructor(private readonly ledgerRepository: MemoryLedgerRepository) {}

  issueNonce(userAddress: HexAddress, nonce: string, createdAt: string): void {
    const normalized = userAddress.toLowerCase() as HexAddress;
    this.ledgerRepository.ensureUser(normalized);
    this.nonces.set(nonceKey(normalized, nonce), {
      nonce,
      userAddress: normalized,
      status: "ISSUED",
      createdAt,
    });
  }

  getNonce(userAddress: HexAddress, nonce: string): StoredNonce | null {
    return this.nonces.get(nonceKey(userAddress, nonce)) ?? null;
  }

  markNonceUsed(userAddress: HexAddress, nonce: string, usedAt: string): void {
    const key = nonceKey(userAddress, nonce);
    const existing = this.nonces.get(key);
    if (existing) {
      this.nonces.set(key, { ...existing, status: "USED", usedAt });
    }
  }

  recordVerifiedIntent(record: StoredSignedIntent): StoredSignedIntent {
    const normalized: StoredSignedIntent = {
      ...record,
      userAddress: record.userAddress.toLowerCase() as HexAddress,
      signer: record.signer.toLowerCase() as HexAddress,
    };
    const nonceLookup = nonceKey(normalized.userAddress, normalized.nonce);
    const existingId = this.intentIdByNonce.get(nonceLookup);
    if (existingId) return this.intentsById.get(existingId) ?? normalized;

    this.ledgerRepository.ensureUser(normalized.userAddress);
    this.intentsById.set(normalized.id, normalized);
    this.intentIdByNonce.set(nonceLookup, normalized.id);
    return normalized;
  }

  getIntentByNonce(
    userAddress: HexAddress,
    nonce: string,
  ): StoredSignedIntent | null {
    const id = this.intentIdByNonce.get(nonceKey(userAddress, nonce));
    return id ? (this.intentsById.get(id) ?? null) : null;
  }

  getIntentById(id: string): StoredSignedIntent | null {
    const intent = this.intentsById.get(id);
    return intent ? { ...intent } : null;
  }

  listIntents(userAddress: HexAddress): StoredSignedIntent[] {
    const normalized = userAddress.toLowerCase();
    return [...this.intentsById.values()]
      .filter((intent) => intent.userAddress.toLowerCase() === normalized)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((intent) => ({ ...intent }));
  }

  listRecentIntents(limit: number): StoredSignedIntent[] {
    return [...this.intentsById.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(0, limit))
      .map((intent) => ({ ...intent }));
  }

  markIntentConsumed(
    id: string,
    settlementId: `0x${string}`,
    consumedAt: string,
  ): void {
    const existing = this.intentsById.get(id);
    if (!existing) return;
    this.intentsById.set(id, {
      ...existing,
      status: "CONSUMED",
      consumedAt,
      consumedBySettlementId: settlementId,
    });
  }

  markIntentExpired(id: string, expiredAt: string): void {
    const existing = this.intentsById.get(id);
    if (!existing) return;
    this.intentsById.set(id, {
      ...existing,
      status: "EXPIRED",
      consumedAt: expiredAt,
    });
  }
}

class MemoryOrdersRepository implements OrdersRepository {
  private readonly orders = new Map<string, Order[]>();
  private readonly nonces = new Map<string, StoredNonce>();
  private readonly idempotencyKeys = new Set<string>();

  listOrders(userAddress: HexAddress): Order[] {
    return [...(this.orders.get(userAddress.toLowerCase()) ?? [])];
  }

  addOrder(order: Order): void {
    const key = order.userAddress.toLowerCase();
    const orders = this.orders.get(key) ?? [];
    if (!orders.some((existing) => existing.orderId === order.orderId)) {
      orders.push({ ...order });
    }
    this.orders.set(key, orders);
  }

  hasClientOrderId(userAddress: HexAddress, clientOrderId: string): boolean {
    return (this.orders.get(userAddress.toLowerCase()) ?? []).some(
      (order) => order.clientOrderId === clientOrderId,
    );
  }

  issueNonce(userAddress: HexAddress, nonce: string, createdAt: string): void {
    this.nonces.set(nonceKey(userAddress, nonce), {
      nonce,
      userAddress,
      status: "ISSUED",
      createdAt,
    });
  }

  getNonce(userAddress: HexAddress, nonce: string): StoredNonce | null {
    return this.nonces.get(nonceKey(userAddress, nonce)) ?? null;
  }

  markNonceUsed(userAddress: HexAddress, nonce: string, usedAt: string): void {
    const key = nonceKey(userAddress, nonce);
    const existing = this.nonces.get(key);
    if (existing) {
      this.nonces.set(key, { ...existing, status: "USED", usedAt });
    }
  }

  addIdempotencyKey(key: string, userAddress: HexAddress): void {
    this.idempotencyKeys.add(idempotencyKey(userAddress, key));
  }

  hasIdempotencyKey(key: string, userAddress: HexAddress): boolean {
    return this.idempotencyKeys.has(idempotencyKey(userAddress, key));
  }
}

class MemoryPositionsRepository implements PositionsRepository {
  private readonly positions = new Map<string, Map<string, Position>>();

  listPositions(userAddress: HexAddress): Position[] {
    return [
      ...(this.positions.get(userAddress.toLowerCase())?.values() ?? []),
    ].map((position) => ({
      ...position,
    }));
  }

  upsertPosition(userAddress: HexAddress, position: Position): void {
    const key = userAddress.toLowerCase();
    const userPositions =
      this.positions.get(key) ?? new Map<string, Position>();
    userPositions.set(position.symbol.toUpperCase(), { ...position });
    this.positions.set(key, userPositions);
  }

  deletePosition(userAddress: HexAddress, symbol: string): void {
    this.positions.get(userAddress.toLowerCase())?.delete(symbol.toUpperCase());
  }
}

class MemoryTradesRepository implements TradesRepository {
  private readonly trades = new Map<string, Trade[]>();

  listTrades(userAddress: HexAddress): Trade[] {
    return [...(this.trades.get(userAddress.toLowerCase()) ?? [])];
  }

  addTrade(trade: Trade): void {
    const key = trade.userAddress.toLowerCase();
    const trades = this.trades.get(key) ?? [];
    if (!trades.some((existing) => existing.tradeId === trade.tradeId)) {
      trades.push({ ...trade });
    }
    this.trades.set(key, trades);
  }
}

class MemorySettlementRepository implements SettlementRepository {
  private readonly settlements = new Map<string, SettlementRecord[]>();

  listSettlements(userAddress: HexAddress): SettlementRecord[] {
    return [...(this.settlements.get(userAddress.toLowerCase()) ?? [])];
  }

  listRecentSettlements(limit: number): SettlementRecord[] {
    return [...this.settlements.values()]
      .flat()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(0, limit))
      .map((settlement) => ({ ...settlement }));
  }

  listPendingSettlements(): SettlementRecord[] {
    return [...this.settlements.values()]
      .flat()
      .filter((settlement) => settlement.status === "ONCHAIN_SUBMITTED")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((settlement) => ({ ...settlement }));
  }

  upsertSettlement(record: SettlementRecord): void {
    const key = record.userAddress.toLowerCase();
    const settlements = this.settlements.get(key) ?? [];
    const index = settlements.findIndex(
      (settlement) =>
        settlement.settlementId === record.settlementId ||
        settlement.txHash === record.txHash,
    );
    if (index >= 0) settlements[index] = { ...record };
    else settlements.push({ ...record });
    this.settlements.set(key, settlements);
  }
}

class MemoryChainEventsRepository implements ChainEventsRepository {
  private readonly events = new Map<string, StoredChainEvent>();
  private readonly cursors = new Map<string, StoredIndexerCursor>();

  claimIndexedEvent(event: IndexedChainEvent): boolean {
    if (this.events.has(event.eventId)) return false;
    const [transactionHash, rawLogIndex = "0"] = event.eventId.split(":");
    this.events.set(event.eventId, {
      id: event.eventId,
      chainId: 0,
      blockNumber: event.blockNumber ?? null,
      transactionHash,
      logIndex: Number(rawLogIndex),
      eventName: event.type,
      userAddress: event.userAddress ?? null,
      payloadJson: JSON.stringify(event),
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  hasIndexedEvent(id: string): boolean {
    return this.events.has(id);
  }

  listRecentEvents(limit: number): StoredChainEvent[] {
    return [...this.events.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(0, limit))
      .map((event) => ({ ...event }));
  }

  getCursor(
    chainId: number,
    contractAddress: string,
  ): StoredIndexerCursor | null {
    return this.cursors.get(cursorKey(chainId, contractAddress)) ?? null;
  }

  saveCursor(cursor: StoredIndexerCursor): void {
    this.cursors.set(cursorKey(cursor.chainId, cursor.contractAddress), {
      ...cursor,
    });
  }
}

function nonceKey(userAddress: HexAddress, nonce: string): string {
  return `${userAddress.toLowerCase()}:${nonce}`;
}

function idempotencyKey(userAddress: HexAddress, key: string): string {
  return `${userAddress.toLowerCase()}:${key}`;
}

function cursorKey(chainId: number, contractAddress: string): string {
  return `${chainId}:${contractAddress.toLowerCase()}`;
}
