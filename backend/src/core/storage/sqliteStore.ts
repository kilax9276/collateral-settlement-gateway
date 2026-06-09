import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

export class SqliteStorage implements AppStorage {
  readonly kind = "sqlite" as const;
  readonly ledgerRepository: LedgerRepository;
  readonly signedIntentsRepository: SignedIntentsRepository;
  readonly ordersRepository: OrdersRepository;
  readonly positionsRepository: PositionsRepository;
  readonly tradesRepository: TradesRepository;
  readonly settlementRepository: SettlementRepository;
  readonly chainEventsRepository: ChainEventsRepository;

  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const absolutePath = resolve(dbPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new DatabaseSync(absolutePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(
      readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    migrateSettlementAuditColumns(this.db);

    this.ledgerRepository = new SqliteLedgerRepository(this.db);
    this.signedIntentsRepository = new SqliteSignedIntentsRepository(
      this.db,
      this.ledgerRepository,
    );
    this.ordersRepository = new SqliteOrdersRepository(this.db);
    this.positionsRepository = new SqlitePositionsRepository(this.db);
    this.tradesRepository = new SqliteTradesRepository(this.db);
    this.settlementRepository = new SqliteSettlementRepository(this.db);
    this.chainEventsRepository = new SqliteChainEventsRepository(this.db);
  }

  close(): void {
    this.db.close();
  }
}

function migrateSettlementAuditColumns(db: DatabaseSync): void {
  for (const statement of [
    "ALTER TABLE settlements ADD COLUMN blockNumber TEXT",
    "ALTER TABLE settlements ADD COLUMN eventName TEXT NOT NULL DEFAULT 'SettlementApplied'",
    "ALTER TABLE settlements ADD COLUMN contractAddress TEXT",
    "ALTER TABLE signed_intents ADD COLUMN consumedAt TEXT",
    "ALTER TABLE signed_intents ADD COLUMN consumedBySettlementId TEXT",
  ]) {
    try {
      db.exec(statement);
    } catch {
      // Existing databases may already have the column. SQLite has no IF NOT EXISTS for ADD COLUMN.
    }
  }
}

class SqliteLedgerRepository implements LedgerRepository {
  constructor(private readonly db: DatabaseSync) {}

  ensureUser(userAddress: HexAddress): void {
    this.db
      .prepare("INSERT OR IGNORE INTO users(address, createdAt) VALUES (?, ?)")
      .run(normalizeAddress(userAddress), new Date().toISOString());
  }

  listUsers(): HexAddress[] {
    return this.db
      .prepare("SELECT address FROM users ORDER BY address ASC")
      .all()
      .map((row) => String(row.address) as HexAddress);
  }

  getBalance(userAddress: HexAddress): StoredBalance | null {
    const row = this.db
      .prepare(
        `SELECT userAddress, collateral, pendingRealizedPnl, pendingWithdrawals, approvedWithdrawals, updatedAt
         FROM balances WHERE userAddress = ?`,
      )
      .get(normalizeAddress(userAddress));
    if (!row) return null;
    return {
      userAddress: row.userAddress as HexAddress,
      collateral: Number(row.collateral),
      pendingSettlementPnl: Number(row.pendingRealizedPnl),
      pendingWithdrawals: Number(row.pendingWithdrawals ?? 0),
      approvedWithdrawals: Number(row.approvedWithdrawals ?? 0),
      updatedAt: String(row.updatedAt),
    };
  }

  saveBalance(balance: StoredBalance): void {
    this.ensureUser(balance.userAddress);
    this.db
      .prepare(
        `INSERT INTO balances(userAddress, collateral, pendingRealizedPnl, pendingWithdrawals, approvedWithdrawals, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(userAddress) DO UPDATE SET
           collateral = excluded.collateral,
           pendingRealizedPnl = excluded.pendingRealizedPnl,
           pendingWithdrawals = excluded.pendingWithdrawals,
           approvedWithdrawals = excluded.approvedWithdrawals,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        normalizeAddress(balance.userAddress),
        balance.collateral,
        balance.pendingSettlementPnl,
        balance.pendingWithdrawals,
        balance.approvedWithdrawals,
        balance.updatedAt,
      );
  }
}

class SqliteSignedIntentsRepository implements SignedIntentsRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ledgerRepository: LedgerRepository,
  ) {}

  issueNonce(userAddress: HexAddress, nonce: string, createdAt: string): void {
    const normalized = normalizeAddress(userAddress);
    this.ledgerRepository.ensureUser(normalized);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO intent_nonces(nonce, userAddress, status, createdAt, usedAt)
         VALUES (?, ?, 'ISSUED', ?, NULL)`,
      )
      .run(nonce, normalized, createdAt);
  }

  getNonce(userAddress: HexAddress, nonce: string): StoredNonce | null {
    const row = this.db
      .prepare(
        "SELECT nonce, userAddress, status, createdAt, usedAt FROM intent_nonces WHERE userAddress = ? AND nonce = ?",
      )
      .get(normalizeAddress(userAddress), nonce);
    if (!row) return null;
    return {
      nonce: String(row.nonce),
      userAddress: row.userAddress as HexAddress,
      status: row.status as StoredNonce["status"],
      createdAt: String(row.createdAt),
      usedAt: row.usedAt ? String(row.usedAt) : null,
    };
  }

  markNonceUsed(userAddress: HexAddress, nonce: string, usedAt: string): void {
    this.db
      .prepare(
        "UPDATE intent_nonces SET status = 'USED', usedAt = ? WHERE userAddress = ? AND nonce = ?",
      )
      .run(usedAt, normalizeAddress(userAddress), nonce);
  }

  recordVerifiedIntent(record: StoredSignedIntent): StoredSignedIntent {
    const normalized: StoredSignedIntent = {
      ...record,
      userAddress: normalizeAddress(record.userAddress),
      signer: normalizeAddress(record.signer),
    };
    this.ledgerRepository.ensureUser(normalized.userAddress);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO signed_intents(
           id, userAddress, appId, intentType, payloadHash, nonce, deadline, signature, signer, status, createdAt, consumedAt, consumedBySettlementId
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.id,
        normalized.userAddress,
        normalized.appId,
        normalized.intentType,
        normalized.payloadHash,
        normalized.nonce,
        normalized.deadline,
        normalized.signature,
        normalized.signer,
        normalized.status,
        normalized.createdAt,
        normalized.consumedAt ?? null,
        normalized.consumedBySettlementId ?? null,
      );

    return (
      this.getIntentByNonce(normalized.userAddress, normalized.nonce) ??
      normalized
    );
  }

  getIntentByNonce(
    userAddress: HexAddress,
    nonce: string,
  ): StoredSignedIntent | null {
    const row = this.db
      .prepare(
        `SELECT id, userAddress, appId, intentType, payloadHash, nonce, deadline, signature, signer, status, createdAt, consumedAt, consumedBySettlementId
         FROM signed_intents WHERE userAddress = ? AND nonce = ?`,
      )
      .get(normalizeAddress(userAddress), nonce);
    return rowToSignedIntent(row);
  }

  getIntentById(id: string): StoredSignedIntent | null {
    const row = this.db
      .prepare(
        `SELECT id, userAddress, appId, intentType, payloadHash, nonce, deadline, signature, signer, status, createdAt, consumedAt, consumedBySettlementId
         FROM signed_intents WHERE id = ?`,
      )
      .get(id);
    return rowToSignedIntent(row);
  }

  listIntents(userAddress: HexAddress): StoredSignedIntent[] {
    return this.db
      .prepare(
        `SELECT id, userAddress, appId, intentType, payloadHash, nonce, deadline, signature, signer, status, createdAt, consumedAt, consumedBySettlementId
         FROM signed_intents WHERE userAddress = ? ORDER BY createdAt ASC, id ASC`,
      )
      .all(normalizeAddress(userAddress))
      .map((row) => rowToSignedIntent(row))
      .filter((intent): intent is StoredSignedIntent => Boolean(intent));
  }

  listRecentIntents(limit: number): StoredSignedIntent[] {
    return this.db
      .prepare(
        `SELECT id, userAddress, appId, intentType, payloadHash, nonce, deadline, signature, signer, status, createdAt, consumedAt, consumedBySettlementId
         FROM signed_intents ORDER BY createdAt DESC, id DESC LIMIT ?`,
      )
      .all(Math.max(0, limit))
      .map((row) => rowToSignedIntent(row))
      .filter((intent): intent is StoredSignedIntent => Boolean(intent));
  }

  markIntentConsumed(
    id: string,
    settlementId: `0x${string}`,
    consumedAt: string,
  ): void {
    this.db
      .prepare(
        "UPDATE signed_intents SET status = 'CONSUMED', consumedAt = ?, consumedBySettlementId = ? WHERE id = ?",
      )
      .run(consumedAt, settlementId, id);
  }

  markIntentExpired(id: string, expiredAt: string): void {
    this.db
      .prepare(
        "UPDATE signed_intents SET status = 'EXPIRED', consumedAt = ? WHERE id = ?",
      )
      .run(expiredAt, id);
  }
}

class SqliteOrdersRepository implements OrdersRepository {
  constructor(private readonly db: DatabaseSync) {}

  listOrders(userAddress: HexAddress): Order[] {
    return this.db
      .prepare(
        `SELECT id, clientOrderId, userAddress, symbol, side, quantity, status, createdAt
         FROM orders WHERE userAddress = ? ORDER BY createdAt ASC, id ASC`,
      )
      .all(normalizeAddress(userAddress))
      .map((row) => ({
        orderId: String(row.id),
        clientOrderId: String(row.clientOrderId),
        userAddress: row.userAddress as HexAddress,
        symbol: String(row.symbol),
        side: row.side as Order["side"],
        type: "MARKET",
        quantity: Number(row.quantity),
        status: row.status as Order["status"],
        createdAt: String(row.createdAt),
      }));
  }

  addOrder(
    order: Order & { price?: number; signature?: string; nonce?: string },
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orders(id, userAddress, symbol, side, quantity, price, clientOrderId, status, signature, nonce, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.orderId,
        normalizeAddress(order.userAddress),
        order.symbol,
        order.side,
        order.quantity,
        order.price ?? null,
        order.clientOrderId,
        order.status,
        order.signature ?? null,
        order.nonce ?? null,
        order.createdAt,
      );
  }

  hasClientOrderId(userAddress: HexAddress, clientOrderId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM orders WHERE userAddress = ? AND clientOrderId = ? LIMIT 1",
      )
      .get(normalizeAddress(userAddress), clientOrderId);
    return Boolean(row);
  }

  issueNonce(userAddress: HexAddress, nonce: string, createdAt: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO order_nonces(nonce, userAddress, status, createdAt, usedAt)
         VALUES (?, ?, 'ISSUED', ?, NULL)`,
      )
      .run(nonce, normalizeAddress(userAddress), createdAt);
  }

  getNonce(userAddress: HexAddress, nonce: string): StoredNonce | null {
    const row = this.db
      .prepare(
        "SELECT nonce, userAddress, status, createdAt, usedAt FROM order_nonces WHERE userAddress = ? AND nonce = ?",
      )
      .get(normalizeAddress(userAddress), nonce);
    if (!row) return null;
    return {
      nonce: String(row.nonce),
      userAddress: row.userAddress as HexAddress,
      status: row.status as StoredNonce["status"],
      createdAt: String(row.createdAt),
      usedAt: row.usedAt ? String(row.usedAt) : null,
    };
  }

  markNonceUsed(userAddress: HexAddress, nonce: string, usedAt: string): void {
    this.db
      .prepare(
        "UPDATE order_nonces SET status = 'USED', usedAt = ? WHERE userAddress = ? AND nonce = ?",
      )
      .run(usedAt, normalizeAddress(userAddress), nonce);
  }

  addIdempotencyKey(
    key: string,
    userAddress: HexAddress,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO idempotency_keys(key, userAddress, createdAt) VALUES (?, ?, ?)",
      )
      .run(key, normalizeAddress(userAddress), createdAt);
  }

  hasIdempotencyKey(key: string, userAddress: HexAddress): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM idempotency_keys WHERE key = ? AND userAddress = ? LIMIT 1",
      )
      .get(key, normalizeAddress(userAddress));
    return Boolean(row);
  }
}

class SqlitePositionsRepository implements PositionsRepository {
  constructor(private readonly db: DatabaseSync) {}

  listPositions(userAddress: HexAddress): Position[] {
    return this.db
      .prepare(
        `SELECT symbol, quantity, entryPrice, realizedPnl, markPrice, updatedAt
         FROM positions WHERE userAddress = ? ORDER BY symbol ASC`,
      )
      .all(normalizeAddress(userAddress))
      .map((row) => ({
        symbol: String(row.symbol),
        quantity: Number(row.quantity),
        avgEntryPrice: Number(row.entryPrice),
        realizedPnl: Number(row.realizedPnl ?? 0),
        unrealizedPnl: 0,
        markPrice: Number(row.markPrice ?? row.entryPrice ?? 0),
      }));
  }

  upsertPosition(
    userAddress: HexAddress,
    position: Position,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO positions(userAddress, symbol, quantity, entryPrice, realizedPnl, markPrice, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userAddress, symbol) DO UPDATE SET
           quantity = excluded.quantity,
           entryPrice = excluded.entryPrice,
           realizedPnl = excluded.realizedPnl,
           markPrice = excluded.markPrice,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        normalizeAddress(userAddress),
        position.symbol.toUpperCase(),
        position.quantity,
        position.avgEntryPrice,
        position.realizedPnl,
        position.markPrice,
        updatedAt,
      );
  }

  deletePosition(userAddress: HexAddress, symbol: string): void {
    this.db
      .prepare("DELETE FROM positions WHERE userAddress = ? AND symbol = ?")
      .run(normalizeAddress(userAddress), symbol.toUpperCase());
  }
}

class SqliteTradesRepository implements TradesRepository {
  constructor(private readonly db: DatabaseSync) {}

  listTrades(userAddress: HexAddress): Trade[] {
    return this.db
      .prepare(
        `SELECT id, orderId, clientOrderId, userAddress, symbol, side, quantity, price, notional, fee, realizedPnl, latencyMs, createdAt
         FROM trades WHERE userAddress = ? ORDER BY createdAt ASC, id ASC`,
      )
      .all(normalizeAddress(userAddress))
      .map((row) => ({
        tradeId: String(row.id),
        orderId: String(row.orderId),
        clientOrderId: String(row.clientOrderId),
        userAddress: row.userAddress as HexAddress,
        symbol: String(row.symbol),
        side: row.side as Trade["side"],
        quantity: Number(row.quantity),
        price: Number(row.price),
        notional: Number(row.notional),
        fee: Number(row.fee),
        realizedPnlDelta: Number(row.realizedPnl),
        latencyMs: Number(row.latencyMs ?? 0),
        ts: String(row.createdAt),
      }));
  }

  addTrade(trade: Trade): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO trades(id, orderId, userAddress, symbol, side, quantity, price, realizedPnl, clientOrderId, notional, fee, latencyMs, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trade.tradeId,
        trade.orderId,
        normalizeAddress(trade.userAddress),
        trade.symbol,
        trade.side,
        trade.quantity,
        trade.price,
        trade.realizedPnlDelta,
        trade.clientOrderId,
        trade.notional,
        trade.fee,
        trade.latencyMs,
        trade.ts,
      );
  }
}

class SqliteSettlementRepository implements SettlementRepository {
  constructor(private readonly db: DatabaseSync) {}

  listSettlements(userAddress: HexAddress): SettlementRecord[] {
    return this.db
      .prepare(
        `SELECT settlementId, reasonHash, userAddress, appId, settlementType, amountDelta,
                referenceIdsJson, metadataJson, txHash, blockNumber, eventName, contractAddress, status, createdAt, confirmedAt
         FROM settlements WHERE userAddress = ? ORDER BY createdAt ASC, id ASC`,
      )
      .all(normalizeAddress(userAddress))
      .map((row) =>
        rowToSettlement(
          row,
          this.listSettlementIntentIds(String(row.settlementId)),
        ),
      );
  }

  listRecentSettlements(limit: number): SettlementRecord[] {
    return this.db
      .prepare(
        `SELECT settlementId, reasonHash, userAddress, appId, settlementType, amountDelta,
                referenceIdsJson, metadataJson, txHash, blockNumber, eventName, contractAddress, status, createdAt, confirmedAt
         FROM settlements ORDER BY createdAt DESC, id DESC LIMIT ?`,
      )
      .all(Math.max(0, limit))
      .map((row) =>
        rowToSettlement(
          row,
          this.listSettlementIntentIds(String(row.settlementId)),
        ),
      );
  }

  listPendingSettlements(): SettlementRecord[] {
    return this.db
      .prepare(
        `SELECT settlementId, reasonHash, userAddress, appId, settlementType, amountDelta,
                referenceIdsJson, metadataJson, txHash, blockNumber, eventName, contractAddress, status, createdAt, confirmedAt
         FROM settlements WHERE status = 'ONCHAIN_SUBMITTED' ORDER BY createdAt DESC, id DESC`,
      )
      .all()
      .map((row) =>
        rowToSettlement(
          row,
          this.listSettlementIntentIds(String(row.settlementId)),
        ),
      );
  }

  private listSettlementIntentIds(settlementId: string): string[] {
    return this.db
      .prepare(
        "SELECT signedIntentId FROM settlement_intents WHERE settlementId = ? ORDER BY createdAt ASC, signedIntentId ASC",
      )
      .all(settlementId)
      .map((row) => String(row.signedIntentId));
  }

  upsertSettlement(record: SettlementRecord): void {
    this.db
      .prepare(
        `INSERT INTO settlements(
           settlementId, userAddress, appId, settlementType, amountDelta, reasonHash,
           referenceIdsJson, metadataJson, txHash, blockNumber, eventName, contractAddress, status, createdAt, confirmedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(settlementId) DO UPDATE SET
           appId = excluded.appId,
           settlementType = excluded.settlementType,
           amountDelta = excluded.amountDelta,
           reasonHash = excluded.reasonHash,
           referenceIdsJson = excluded.referenceIdsJson,
           metadataJson = excluded.metadataJson,
           txHash = excluded.txHash,
           blockNumber = excluded.blockNumber,
           eventName = excluded.eventName,
           contractAddress = excluded.contractAddress,
           status = excluded.status,
           confirmedAt = excluded.confirmedAt`,
      )
      .run(
        record.settlementId,
        normalizeAddress(record.userAddress),
        record.appId,
        record.settlementType,
        record.amountDelta,
        record.reasonHash,
        JSON.stringify(record.referenceIds ?? []),
        record.metadata === undefined ? null : JSON.stringify(record.metadata),
        record.txHash,
        record.onChain.blockNumber,
        record.onChain.eventName,
        record.onChain.contractAddress,
        record.status,
        record.createdAt,
        record.confirmedAt,
      );

    this.db
      .prepare("DELETE FROM settlement_intents WHERE settlementId = ?")
      .run(record.settlementId);
    for (const signedIntentId of record.signedIntentIds ?? []) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO settlement_intents(settlementId, signedIntentId, createdAt)
           VALUES (?, ?, ?)`,
        )
        .run(record.settlementId, signedIntentId, record.createdAt);
    }
  }
}

function rowToSettlement(
  row: unknown,
  signedIntentIds: string[] = [],
): SettlementRecord {
  const value = row as Record<string, unknown>;
  const amountDelta = Number(value.amountDelta);
  return {
    settlementId: String(
      value.settlementId,
    ) as SettlementRecord["settlementId"],
    reasonHash: String(value.reasonHash) as SettlementRecord["reasonHash"],
    userAddress: value.userAddress as HexAddress,
    appId: String(value.appId),
    settlementType: String(value.settlementType),
    amountDelta,
    pnl: amountDelta,
    referenceIds: parseJsonArray(value.referenceIdsJson),
    signedIntentIds,
    metadata: parseJsonObject(value.metadataJson),
    status: value.status as SettlementRecord["status"],
    txHash: String(value.txHash),
    onChain: {
      txHash: String(value.txHash),
      blockNumber:
        value.blockNumber === null || value.blockNumber === undefined
          ? null
          : String(value.blockNumber),
      eventName: String(value.eventName ?? "SettlementApplied"),
      contractAddress:
        value.contractAddress === null || value.contractAddress === undefined
          ? null
          : (String(value.contractAddress) as HexAddress),
    },
    createdAt: String(value.createdAt),
    confirmedAt:
      value.confirmedAt === null || value.confirmedAt === undefined
        ? null
        : String(value.confirmedAt),
    ts: String(value.confirmedAt ?? value.createdAt),
  };
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

class SqliteChainEventsRepository implements ChainEventsRepository {
  constructor(private readonly db: DatabaseSync) {}

  claimIndexedEvent(event: IndexedChainEvent): boolean {
    const [transactionHash, rawLogIndex = "0"] = event.eventId.split(":");
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO indexed_chain_events(
           id, chainId, blockNumber, transactionHash, logIndex, eventName, userAddress, payloadJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        Number(process.env.CHAIN_ID ?? 31337),
        event.blockNumber ?? null,
        transactionHash,
        Number(rawLogIndex),
        event.type,
        event.userAddress ? normalizeAddress(event.userAddress) : null,
        JSON.stringify(event),
        new Date().toISOString(),
      );
    return Number(result.changes) > 0;
  }

  hasIndexedEvent(id: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM indexed_chain_events WHERE id = ? LIMIT 1")
      .get(id);
    return Boolean(row);
  }

  listRecentEvents(limit: number): StoredChainEvent[] {
    return this.db
      .prepare(
        `SELECT id, chainId, blockNumber, transactionHash, logIndex, eventName, userAddress, payloadJson, createdAt
         FROM indexed_chain_events ORDER BY createdAt DESC, blockNumber DESC, logIndex DESC LIMIT ?`,
      )
      .all(Math.max(0, limit))
      .map(rowToStoredChainEvent);
  }

  getCursor(
    chainId: number,
    contractAddress: string,
  ): StoredIndexerCursor | null {
    const row = this.db
      .prepare(
        "SELECT chainId, contractAddress, lastProcessedBlock FROM indexer_cursor WHERE chainId = ? AND contractAddress = ?",
      )
      .get(chainId, contractAddress.toLowerCase());
    if (!row) return null;
    return {
      chainId: Number(row.chainId),
      contractAddress: String(row.contractAddress),
      lastProcessedBlock: String(row.lastProcessedBlock),
    };
  }

  saveCursor(cursor: StoredIndexerCursor): void {
    this.db
      .prepare(
        `INSERT INTO indexer_cursor(chainId, contractAddress, lastProcessedBlock)
         VALUES (?, ?, ?)
         ON CONFLICT(chainId, contractAddress) DO UPDATE SET lastProcessedBlock = excluded.lastProcessedBlock`,
      )
      .run(
        cursor.chainId,
        cursor.contractAddress.toLowerCase(),
        cursor.lastProcessedBlock,
      );
  }
}

function rowToStoredChainEvent(row: unknown): StoredChainEvent {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    chainId: Number(value.chainId),
    blockNumber:
      value.blockNumber === null || value.blockNumber === undefined
        ? null
        : String(value.blockNumber),
    transactionHash: String(value.transactionHash),
    logIndex: Number(value.logIndex),
    eventName: String(value.eventName),
    userAddress:
      value.userAddress === null || value.userAddress === undefined
        ? null
        : (String(value.userAddress) as HexAddress),
    payloadJson: String(value.payloadJson),
    createdAt: String(value.createdAt),
  };
}

function rowToSignedIntent(row: unknown): StoredSignedIntent | null {
  if (!row) return null;
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    userAddress: String(value.userAddress) as HexAddress,
    appId: String(value.appId),
    intentType: String(value.intentType),
    payloadHash: String(value.payloadHash) as `0x${string}`,
    nonce: String(value.nonce),
    deadline: Number(value.deadline),
    signature: String(value.signature) as `0x${string}`,
    signer: String(value.signer) as HexAddress,
    status: value.status as StoredSignedIntent["status"],
    createdAt: String(value.createdAt),
    consumedAt:
      value.consumedAt === null || value.consumedAt === undefined
        ? null
        : String(value.consumedAt),
    consumedBySettlementId:
      value.consumedBySettlementId === null ||
      value.consumedBySettlementId === undefined
        ? null
        : (String(
            value.consumedBySettlementId,
          ) as StoredSignedIntent["consumedBySettlementId"]),
  };
}

function normalizeAddress(address: HexAddress): HexAddress {
  return address.toLowerCase() as HexAddress;
}
