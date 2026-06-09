CREATE TABLE IF NOT EXISTS indexed_chain_events (
  id TEXT PRIMARY KEY,
  chainId INTEGER NOT NULL,
  blockNumber TEXT,
  transactionHash TEXT NOT NULL,
  logIndex INTEGER NOT NULL,
  eventName TEXT NOT NULL,
  userAddress TEXT,
  payloadJson TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_indexed_chain_events_user ON indexed_chain_events(userAddress);
CREATE INDEX IF NOT EXISTS idx_indexed_chain_events_block ON indexed_chain_events(chainId, blockNumber);

CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS balances (
  userAddress TEXT PRIMARY KEY,
  collateral REAL NOT NULL DEFAULT 0,
  pendingRealizedPnl REAL NOT NULL DEFAULT 0,
  pendingWithdrawals REAL NOT NULL DEFAULT 0,
  approvedWithdrawals REAL NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS intent_nonces (
  nonce TEXT NOT NULL,
  userAddress TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  usedAt TEXT,
  PRIMARY KEY(nonce, userAddress),
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS signed_intents (
  id TEXT PRIMARY KEY,
  userAddress TEXT NOT NULL,
  appId TEXT NOT NULL,
  intentType TEXT NOT NULL,
  payloadHash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  signature TEXT NOT NULL,
  signer TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  consumedAt TEXT,
  consumedBySettlementId TEXT,
  UNIQUE(userAddress, nonce),
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_signed_intents_user ON signed_intents(userAddress);
CREATE INDEX IF NOT EXISTS idx_signed_intents_app_type ON signed_intents(appId, intentType);
CREATE INDEX IF NOT EXISTS idx_signed_intents_payload_hash ON signed_intents(payloadHash);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  userAddress TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL,
  clientOrderId TEXT NOT NULL,
  status TEXT NOT NULL,
  signature TEXT,
  nonce TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE(userAddress, clientOrderId),
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(userAddress);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  orderId TEXT NOT NULL,
  userAddress TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  realizedPnl REAL NOT NULL,
  clientOrderId TEXT,
  notional REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  latencyMs REAL NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(userAddress);
CREATE INDEX IF NOT EXISTS idx_trades_order ON trades(orderId);

CREATE TABLE IF NOT EXISTS positions (
  userAddress TEXT NOT NULL,
  symbol TEXT NOT NULL,
  quantity REAL NOT NULL,
  entryPrice REAL NOT NULL,
  realizedPnl REAL NOT NULL DEFAULT 0,
  markPrice REAL NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY(userAddress, symbol),
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  settlementId TEXT NOT NULL UNIQUE,
  userAddress TEXT NOT NULL,
  appId TEXT NOT NULL,
  settlementType TEXT NOT NULL,
  amountDelta REAL NOT NULL,
  reasonHash TEXT NOT NULL,
  referenceIdsJson TEXT NOT NULL DEFAULT '[]',
  metadataJson TEXT,
  txHash TEXT NOT NULL,
  blockNumber TEXT,
  eventName TEXT NOT NULL DEFAULT 'SettlementApplied',
  contractAddress TEXT,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  confirmedAt TEXT,
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_settlements_user ON settlements(userAddress);
CREATE INDEX IF NOT EXISTS idx_settlements_tx ON settlements(txHash);

CREATE TABLE IF NOT EXISTS settlement_intents (
  settlementId TEXT NOT NULL,
  signedIntentId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY(settlementId, signedIntentId),
  FOREIGN KEY(settlementId) REFERENCES settlements(settlementId) ON DELETE CASCADE,
  FOREIGN KEY(signedIntentId) REFERENCES signed_intents(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_settlement_intents_intent ON settlement_intents(signedIntentId);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  userAddress TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY(key, userAddress),
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_nonces (
  nonce TEXT NOT NULL,
  userAddress TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  usedAt TEXT,
  PRIMARY KEY(nonce, userAddress),
  FOREIGN KEY(userAddress) REFERENCES users(address) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS indexer_cursor (
  chainId INTEGER NOT NULL,
  contractAddress TEXT NOT NULL,
  lastProcessedBlock TEXT NOT NULL,
  PRIMARY KEY(chainId, contractAddress)
);
