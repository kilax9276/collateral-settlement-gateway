import { DatabaseSync } from "node:sqlite";
import { config } from "../backend/src/config.js";

const settlementId = process.argv[2];

if (!settlementId || !/^0x[a-fA-F0-9]{64}$/.test(settlementId)) {
  console.error("Usage: npm run settlement:report -- <settlementId>");
  process.exit(1);
}

if (config.storageDriver !== "sqlite") {
  console.error(
    "settlement:report requires STORAGE_DRIVER=sqlite and a populated SQLITE_PATH.",
  );
  process.exit(1);
}

type SettlementRow = {
  settlementId: string;
  userAddress: string;
  appId: string;
  settlementType: string;
  amountDelta: number;
  reasonHash: string;
  referenceIdsJson: string;
  metadataJson: string | null;
  txHash: string;
  blockNumber: string | null;
  eventName: string | null;
  contractAddress: string | null;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
};

type TradeRow = {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  realizedPnl: number;
  fee: number;
};

type IntentRow = {
  id: string;
  appId: string;
  intentType: string;
  payloadHash: string;
  nonce: string;
  signer: string;
  status: string;
};

const db = new DatabaseSync(config.sqlitePath, { readOnly: true });

try {
  const settlement = db
    .prepare(
      `SELECT settlementId, userAddress, appId, settlementType, amountDelta, reasonHash,
              referenceIdsJson, metadataJson, txHash, blockNumber, eventName, contractAddress,
              status, createdAt, confirmedAt
       FROM settlements WHERE lower(settlementId) = lower(?) LIMIT 1`,
    )
    .get(settlementId) as SettlementRow | undefined;

  if (!settlement) {
    console.error(`Settlement not found: ${settlementId}`);
    process.exit(1);
  }

  const referenceIds = parseJsonArray(settlement.referenceIdsJson);
  const metadata = parseJsonObject(settlement.metadataJson);
  const linkedTrades = referenceIds.length
    ? (db
        .prepare(
          `SELECT id, symbol, side, quantity, price, realizedPnl, fee
           FROM trades
           WHERE userAddress = ? AND id IN (${referenceIds.map(() => "?").join(",")})
           ORDER BY createdAt ASC, id ASC`,
        )
        .all(settlement.userAddress, ...referenceIds) as TradeRow[])
    : [];
  const linkedIntents = db
    .prepare(
      `SELECT si.id, si.appId, si.intentType, si.payloadHash, si.nonce, si.signer, si.status
       FROM settlement_intents link
       JOIN signed_intents si ON si.id = link.signedIntentId
       WHERE link.settlementId = ?
       ORDER BY link.createdAt ASC, si.id ASC`,
    )
    .all(settlement.settlementId) as IntentRow[];
  const signedIntentIds = linkedIntents.map((intent) => intent.id);

  console.log("Settlement Audit Report");
  console.log("=======================");
  console.log(`Settlement ID: ${settlement.settlementId}`);
  console.log(`User: ${settlement.userAddress}`);
  console.log(`App ID: ${settlement.appId}`);
  console.log(`Settlement Type: ${settlement.settlementType}`);
  console.log(`Amount Delta: ${Number(settlement.amountDelta)}`);
  console.log(`Reason Hash: ${settlement.reasonHash}`);
  console.log(
    `Linked Trades/References: ${referenceIds.length ? referenceIds.join(", ") : "none"}`,
  );
  console.log(
    `Linked Signed Intents: ${signedIntentIds.length ? signedIntentIds.join(", ") : "none"}`,
  );
  for (const intent of linkedIntents) {
    console.log(
      `  - ${intent.id}: appId=${intent.appId}, intentType=${intent.intentType}, status=${intent.status}, signer=${intent.signer}`,
    );
  }
  console.log(`Tx Hash: ${settlement.txHash}`);
  console.log(`Block Number: ${settlement.blockNumber ?? "unknown"}`);
  console.log(`Event: ${settlement.eventName ?? "SettlementApplied"}`);
  console.log(`Contract: ${settlement.contractAddress ?? "unknown"}`);

  if (settlement.settlementType === "TRADING_PNL") {
    const summary = tradingSummary(
      linkedTrades,
      Number(settlement.amountDelta),
    );
    console.log("Trading Summary:");
    console.log(`  Symbol: ${summary.symbol ?? "unknown"}`);
    console.log(`  Entry Price: ${summary.entryPrice ?? "unknown"}`);
    console.log(`  Exit Price: ${summary.exitPrice ?? "unknown"}`);
    console.log(`  Quantity: ${summary.quantity}`);
    console.log(`  Gross P&L: ${summary.grossPnl}`);
    console.log(`  Fees: ${summary.fees}`);
    console.log(`  Net P&L: ${summary.netPnl}`);
  }

  if (metadata) {
    console.log(`Metadata: ${JSON.stringify(metadata)}`);
  }

  console.log(`Final Status: ${settlement.status}`);
  console.log(`Created At: ${settlement.createdAt}`);
  console.log(`Confirmed At: ${settlement.confirmedAt ?? "pending"}`);
} finally {
  db.close();
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tradingSummary(trades: TradeRow[], amountDelta: number) {
  const buys = trades.filter((trade) => trade.side === "BUY");
  const sells = trades.filter((trade) => trade.side === "SELL");
  const buyQuantity = buys.reduce(
    (sum, trade) => sum + Number(trade.quantity),
    0,
  );
  const sellQuantity = sells.reduce(
    (sum, trade) => sum + Number(trade.quantity),
    0,
  );
  const grossPnl = roundMoney(
    trades.reduce((sum, trade) => sum + Number(trade.realizedPnl), 0),
  );
  const fees = roundMoney(
    trades.reduce((sum, trade) => sum + Number(trade.fee), 0),
  );
  return {
    symbol: trades[0]?.symbol ?? null,
    entryPrice: weightedAveragePrice(buys, buyQuantity),
    exitPrice: weightedAveragePrice(sells, sellQuantity),
    quantity: roundMoney(sellQuantity || buyQuantity),
    grossPnl,
    fees,
    netPnl: roundMoney(grossPnl - fees || amountDelta),
  };
}

function weightedAveragePrice(
  trades: TradeRow[],
  quantity: number,
): number | null {
  if (quantity <= 0) return null;
  return roundMoney(
    trades.reduce(
      (sum, trade) => sum + Number(trade.price) * Number(trade.quantity),
      0,
    ) / quantity,
  );
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
