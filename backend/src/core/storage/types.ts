import type {
  HexAddress,
  IndexedChainEvent,
  Order,
  Position,
  SettlementRecord,
  SignedIntentStatus,
  Trade,
} from "../../types/domain.js";

export type StoredBalance = {
  userAddress: HexAddress;
  collateral: number;
  pendingSettlementPnl: number;
  pendingWithdrawals: number;
  approvedWithdrawals: number;
  updatedAt: string;
};

export type StoredSignedIntent = {
  id: string;
  userAddress: HexAddress;
  appId: string;
  intentType: string;
  payloadHash: `0x${string}`;
  nonce: string;
  deadline: number;
  signature: `0x${string}`;
  signer: HexAddress;
  status: SignedIntentStatus;
  createdAt: string;
  consumedAt?: string | null;
  consumedBySettlementId?: `0x${string}` | null;
};

export type StoredNonce = {
  nonce: string;
  userAddress: HexAddress;
  status: "ISSUED" | "USED";
  createdAt: string;
  usedAt?: string | null;
};

export type StoredChainEvent = {
  id: string;
  chainId: number;
  blockNumber: string | null;
  transactionHash: string;
  logIndex: number;
  eventName: string;
  userAddress: HexAddress | null;
  payloadJson: string;
  createdAt: string;
};

export type StoredIndexerCursor = {
  chainId: number;
  contractAddress: string;
  lastProcessedBlock: string;
};

export interface LedgerRepository {
  ensureUser(userAddress: HexAddress): void;
  listUsers(): HexAddress[];
  getBalance(userAddress: HexAddress): StoredBalance | null;
  saveBalance(balance: StoredBalance): void;
}

export interface SignedIntentsRepository {
  issueNonce(userAddress: HexAddress, nonce: string, createdAt: string): void;
  getNonce(userAddress: HexAddress, nonce: string): StoredNonce | null;
  markNonceUsed(userAddress: HexAddress, nonce: string, usedAt: string): void;
  recordVerifiedIntent(record: StoredSignedIntent): StoredSignedIntent;
  getIntentByNonce(
    userAddress: HexAddress,
    nonce: string,
  ): StoredSignedIntent | null;
  getIntentById(id: string): StoredSignedIntent | null;
  listIntents(userAddress: HexAddress): StoredSignedIntent[];
  listRecentIntents(limit: number): StoredSignedIntent[];
  markIntentConsumed(
    id: string,
    settlementId: `0x${string}`,
    consumedAt: string,
  ): void;
  markIntentExpired(id: string, expiredAt: string): void;
}

export interface OrdersRepository {
  listOrders(userAddress: HexAddress): Order[];
  addOrder(
    order: Order & { price?: number; signature?: string; nonce?: string },
  ): void;
  hasClientOrderId(userAddress: HexAddress, clientOrderId: string): boolean;
  issueNonce(userAddress: HexAddress, nonce: string, createdAt: string): void;
  getNonce(userAddress: HexAddress, nonce: string): StoredNonce | null;
  markNonceUsed(userAddress: HexAddress, nonce: string, usedAt: string): void;
  addIdempotencyKey(
    key: string,
    userAddress: HexAddress,
    createdAt: string,
  ): void;
  hasIdempotencyKey(key: string, userAddress: HexAddress): boolean;
}

export interface PositionsRepository {
  listPositions(userAddress: HexAddress): Position[];
  upsertPosition(
    userAddress: HexAddress,
    position: Position,
    updatedAt: string,
  ): void;
  deletePosition(userAddress: HexAddress, symbol: string): void;
}

export interface TradesRepository {
  listTrades(userAddress: HexAddress): Trade[];
  addTrade(trade: Trade): void;
}

export interface SettlementRepository {
  listSettlements(userAddress: HexAddress): SettlementRecord[];
  listRecentSettlements(limit: number): SettlementRecord[];
  listPendingSettlements(): SettlementRecord[];
  upsertSettlement(record: SettlementRecord): void;
}

export interface ChainEventsRepository {
  claimIndexedEvent(event: IndexedChainEvent): boolean;
  hasIndexedEvent(id: string): boolean;
  listRecentEvents(limit: number): StoredChainEvent[];
  getCursor(
    chainId: number,
    contractAddress: string,
  ): StoredIndexerCursor | null;
  saveCursor(cursor: StoredIndexerCursor): void;
}

export interface AppStorage {
  kind: "memory" | "sqlite";
  ledgerRepository: LedgerRepository;
  signedIntentsRepository: SignedIntentsRepository;
  ordersRepository: OrdersRepository;
  positionsRepository: PositionsRepository;
  tradesRepository: TradesRepository;
  settlementRepository: SettlementRepository;
  chainEventsRepository: ChainEventsRepository;
  close(): void;
}
