export type HexAddress = `0x${string}`;
export type HexString = `0x${string}`;

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET";

export type SignedIntent = {
  userAddress: HexAddress;
  appId: string;
  intentType: string;
  payloadHash: HexString;
  nonce: string;
  deadline: number;
};

export type SignedIntentRequest = {
  intent: SignedIntent;
  signature: HexString;
};

export type SignedIntentStatus = "VERIFIED" | "CONSUMED" | "EXPIRED";

export type VerifiedSignedIntent = {
  valid: true;
  signer: HexAddress;
  intent: SignedIntent;
  intentId: string;
  status: "VERIFIED";
  nonceConsumed: boolean;
};

export type LinkedSignedIntentReport = {
  id: string;
  appId: string;
  intentType: string;
  payloadHash: HexString;
  nonce: string;
  signer: HexAddress;
  userAddress: HexAddress;
  deadline: number;
  status: SignedIntentStatus;
  createdAt: string;
  consumedAt?: string | null;
  consumedBySettlementId?: HexString | null;
};

export type Quote = {
  symbol: string;
  price: number;
  source: string;
  timestamp: string;
  ts: string;
  confidence?: number;
  confidenceInterval?: number;
  raw?: unknown;
};

export type Position = {
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  markPrice: number;
};

export type Portfolio = {
  userAddress: HexAddress;
  collateral: number;
  equity: number;
  marginUsed: number;
  freeCollateral: number;
  pendingSettlementPnl: number;
  pendingWithdrawals: number;
  approvedWithdrawals: number;
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  settlements: SettlementRecord[];
  ts: string;
};

export type OrderRequest = {
  userAddress: HexAddress;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  clientOrderId: string;
};

export type SignedOrderPayload = {
  userAddress: HexAddress;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  clientOrderId: string;
  nonce: string;
  deadline: number;
};

export type SignedOrderRequest = {
  order: SignedOrderPayload;
  signature: HexString;
};

export type SignedTradingOrderRequest = {
  order: OrderRequest;
  intent: SignedIntent;
  signature: HexString;
};

export type WithdrawalRequest = {
  userAddress: HexAddress;
  amount: number;
  signedIntentId: string;
};

export type OrderNonce = {
  userAddress: HexAddress;
  nonce: string;
  issuedAt: string;
};

export type Order = {
  orderId: string;
  clientOrderId: string;
  userAddress: HexAddress;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  status: "FILLED";
  createdAt: string;
};

export type Trade = {
  tradeId: string;
  orderId: string;
  clientOrderId: string;
  userAddress: HexAddress;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  notional: number;
  fee: number;
  realizedPnlDelta: number;
  latencyMs: number;
  ts: string;
};

export type SettlementRequest = {
  userAddress: HexAddress;
  appId: string;
  settlementType: string;
  amountDelta: string;
  reasonHash: HexString;
  referenceIds: string[];
  signedIntentIds: string[];
  metadata?: Record<string, unknown>;
};

export type NormalizedSettlementRequest = {
  userAddress: HexAddress;
  appId: string;
  settlementType: string;
  amountDelta: number;
  reasonHash: HexString;
  referenceIds: string[];
  signedIntentIds: string[];
  metadata?: Record<string, unknown>;
};

export type SettlementOnChainData = {
  txHash: string;
  blockNumber: string | null;
  eventName: string;
  contractAddress: HexAddress | null;
};

export type SettlementRecord = {
  settlementId: HexString;
  reasonHash: HexString;
  userAddress: HexAddress;
  appId: string;
  settlementType: string;
  amountDelta: number;
  /** @deprecated Use amountDelta. Kept so earlier trading demo clients remain readable. */
  pnl: number;
  referenceIds: string[];
  signedIntentIds: string[];
  metadata?: Record<string, unknown>;
  status: "ONCHAIN_SUBMITTED" | "ONCHAIN_CONFIRMED";
  txHash: string;
  onChain: SettlementOnChainData;
  createdAt: string;
  confirmedAt: string | null;
  ts: string;
};

export type WithdrawalRecord = {
  withdrawalId: string;
  userAddress: HexAddress;
  amount: number;
  status: "ONCHAIN_REQUESTED" | "ONCHAIN_APPROVED";
  txHash: string;
  ts: string;
};

export type IndexedChainEvent = {
  eventId: string;
  type:
    | "Deposited"
    | "WithdrawRequested"
    | "WithdrawApproved"
    | "Withdrawn"
    | "SettlementApplied"
    | "PnlSettled";
  userAddress: HexAddress;
  amount?: number;
  amountDelta?: number;
  pnl?: number;
  newBalance?: number;
  settlementId?: HexString;
  reasonHash?: HexString;
  txHash: string;
  blockNumber?: string;
  logIndex?: number;
  ts: string;
};

export type OrderResult = {
  order: Order;
  trade: Trade;
  portfolio: Portfolio;
};

export type SettlementResult = {
  settlement: SettlementRecord;
  portfolio: Portfolio;
};

export type WithdrawalResult = {
  withdrawal: WithdrawalRecord;
  portfolio: Portfolio;
};

export type PositionUpdate = {
  userAddress: HexAddress;
  positions: Position[];
  ts: string;
};

export type RealtimeEvent =
  | {
      type: "system:connected";
      payload: { message: string; quotes: Quote[]; ts: string };
    }
  | { type: "price:update"; payload: Quote }
  | { type: "order:created"; payload: Order }
  | { type: "trade:executed"; payload: Trade }
  | { type: "position:updated"; payload: PositionUpdate }
  | { type: "portfolio:updated"; payload: Portfolio }
  | { type: "settlement:submitted"; payload: SettlementRecord }
  | { type: "settlement:confirmed"; payload: SettlementRecord }
  | { type: "withdrawal:requested"; payload: WithdrawalRecord }
  | { type: "withdrawal:approved"; payload: WithdrawalRecord }
  | { type: "chain:deposited"; payload: IndexedChainEvent }
  | { type: "chain:withdraw_requested"; payload: IndexedChainEvent }
  | { type: "chain:withdraw_approved"; payload: IndexedChainEvent }
  | { type: "chain:withdrawn"; payload: IndexedChainEvent };

export type ReconciliationStatus = "OK" | "WARNING" | "MISMATCH";

export type ReconciliationReport = {
  userAddress: HexAddress;
  onChainBalance: number | null;
  offChainBalance: number;
  pendingRealizedPnl: number;
  openPosition: boolean;
  openPositions: Position[];
  pendingWithdraw: number;
  onChainPendingWithdraw: number | null;
  offChainPendingWithdraw: number;
  settlementHistory: SettlementRecord[];
  status: ReconciliationStatus;
  detectedIssues: string[];
  ts: string;
};

export type GatewayMetricsReport = {
  chainId: number;
  vaultAddress: HexAddress | null;
  operatorAddress: HexAddress | null;
  indexer: {
    enabled: boolean;
    status: "running" | "stopped" | "disabled";
    lastProcessedBlock: string | null;
    lagBlocks: number | null;
  };
  storage: {
    driver: "memory" | "sqlite";
    status: "OK" | "UNAVAILABLE";
    path?: string;
  };
  collateral: {
    totalUsers: number;
    totalUserCollateral: number;
    totalLiabilities: number | null;
    insuranceBalance: number | null;
  };
  operations: {
    pendingWithdrawals: number;
    pendingSettlements: number;
    recentSettlements: number;
    recentSignedIntents: number;
  };
  tradingExample: {
    openPositions: number;
    supportedSymbols: string[];
  };
  reconciliationSummary: Record<ReconciliationStatus, number>;
  ts: string;
};

export type SystemHealthReport = {
  chainId: number;
  vaultAddress: HexAddress | null;
  indexer: {
    enabled: boolean;
    started: boolean;
    lastProcessedBlock: string | null;
  };
  sqlite: {
    driver: "memory" | "sqlite";
    status: "OK" | "UNAVAILABLE";
    path?: string;
  };
  ts: string;
};
