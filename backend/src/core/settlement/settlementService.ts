import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { nanoid } from "nanoid";
import type { AppConfig } from "../../config.js";
import type {
  HexAddress,
  HexString,
  LinkedSignedIntentReport,
  NormalizedSettlementRequest,
  SettlementRecord,
  SettlementRequest,
  SettlementResult,
  Trade,
} from "../../types/domain.js";
import {
  calculateNotional,
  decimalAdd,
  decimalDiv,
  decimalSub,
  fromMicroUsdc,
  parseSettlementAmount,
  roundMoney,
} from "../money/money.js";
import { conflict, notFound } from "../../utils/errors.js";
import {
  hasUsableVaultDeployment,
  loadContractsConfig,
} from "../../utils/contracts.js";
import type { ContractsConfig } from "../../types/contracts.js";
import type { Ledger, UserLedgerState } from "../storage/gatewayLedger.js";
import type { StoredSignedIntent } from "../storage/index.js";
import type { SettlementAuthContext } from "../auth/appRegistry.js";
import type { MarketDataService } from "../../examples/trading/marketData.js";

const LOCAL_HARDHAT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export type SettlementLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type SettlementSubmittedHandler = (
  record: SettlementRecord,
  portfolio: SettlementResult["portfolio"],
) => void;

export type SubmitSettlementAuthContext =
  | SettlementAuthContext
  | { kind: "internal" };

export type SettlementAuditReport = {
  settlementId: HexString;
  userAddress: HexAddress;
  appId: string;
  settlementType: string;
  amountDelta: number;
  accounting: {
    amountDeltaMicroUsdc: string;
    formattedAmountDelta: string;
    storageModel: "DECIMAL_API_WITH_INTEGER_CONTRACT_UNITS";
  };
  reasonHash: HexString;
  referenceIds: string[];
  metadata?: Record<string, unknown>;
  offChainCalculation: {
    source: "gateway-ledger";
    reasonHash: HexString;
    referenceIds: string[];
    metadata?: Record<string, unknown>;
    portfolioTimestamp: string;
  };
  signedIntentIds: string[];
  linkedSignedIntents: LinkedSignedIntentReport[];
  audit: {
    authorization: "admin" | "app" | "internal" | "unknown";
    trustedOperatorSettlement: boolean;
    warnings: string[];
  };
  onChain: {
    txHash: string;
    blockNumber: string | null;
    eventName: string;
    contractAddress: HexAddress | null;
  };
  status: SettlementRecord["status"];
  createdAt: string;
  confirmedAt: string | null;
  trading?: {
    symbol: string | null;
    entryPrice: number | null;
    exitPrice: number | null;
    quantity: number;
    grossPnl: number;
    fees: number;
    netPnl: number;
    tradeIds: string[];
  };
};

type SettlementEvent = {
  userAddress: Address;
  amountDelta: number;
  newBalance: number;
  settlementId: Hex;
  reasonHash: Hex;
};

export class SettlementService {
  constructor(
    private readonly ledger: Ledger,
    private readonly marketData: MarketDataService,
    private readonly appConfig: AppConfig,
    private readonly logger: SettlementLogger = console,
  ) {}

  async submitSettlement(
    rawRequest: SettlementRequest,
    onSubmitted?: SettlementSubmittedHandler,
    authContext: SubmitSettlementAuthContext = { kind: "admin" },
  ): Promise<SettlementResult> {
    const request = this.prepareSettlementRequest(
      normalizeSettlementRequest(rawRequest),
      authContext,
    );
    if (request.amountDelta === 0) {
      throw conflict(
        "ZERO_SETTLEMENT_AMOUNT",
        "Settlement amountDelta must not be zero",
      );
    }

    const state = this.ledger.getOrCreate(request.userAddress);
    if (state.settlementInFlight) {
      throw conflict(
        "SETTLEMENT_ALREADY_IN_FLIGHT",
        `Settlement is already in flight for this user: ${state.settlementInFlight.txHash ?? "tx pending"}`,
      );
    }

    const settlementId = buildSettlementId(request);
    const contracts = await this.loadUsableContracts();
    const vaultAddress = getAddress(
      contracts.collateralVault.address as Address,
    );
    const vaultAbi = contracts.collateralVault.abi as Abi;
    const { publicClient, walletClient, operatorAddress, operatorAccount } =
      this.createClients(contracts);

    const expectedOperator = contracts.operator
      ? getAddress(contracts.operator)
      : null;
    if (expectedOperator && expectedOperator !== operatorAddress) {
      throw conflict(
        "OPERATOR_MISMATCH",
        `OPERATOR_PRIVATE_KEY resolves to ${operatorAddress}, but deployed Vault operator is ${expectedOperator}`,
      );
    }

    const settlementAmount = parseSettlementAmount(request.amountDelta);
    const amountDeltaMicroUsdc = settlementAmount.microUsdc;
    this.ledger.beginOnchainSettlement(
      request.userAddress,
      request,
      settlementId,
    );

    try {
      const txHash = await walletClient.writeContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: "settle",
        args: [
          getAddress(request.userAddress),
          amountDeltaMicroUsdc,
          settlementId,
          request.reasonHash,
        ],
        account: operatorAccount,
        chain: null,
      });

      this.logger.info(
        `Settlement tx submitted for ${request.userAddress}: appId=${request.appId}, settlementType=${request.settlementType}, amountDelta=${request.amountDelta}, settlementId=${settlementId}, reasonHash=${request.reasonHash}, txHash=${txHash}`,
      );
      const submitted = this.ledger.recordOnchainSettlementSubmitted(
        request.userAddress,
        request,
        txHash,
        settlementId,
        { contractAddress: vaultAddress, eventName: "SettlementApplied" },
      );
      const submittedPortfolio = this.ledger.snapshot(
        request.userAddress,
        (symbol) => this.marketData.getQuote(symbol).price,
        this.appConfig.maxLeverage,
      );
      onSubmitted?.(submitted, submittedPortfolio);

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      if (receipt.status !== "success") {
        throw conflict(
          "SETTLEMENT_TX_REVERTED",
          `Settlement transaction reverted: ${txHash}`,
        );
      }

      const settlementEvent = parseSettlementAppliedEvent(
        vaultAbi,
        receipt.logs,
        request.userAddress,
      );
      if (!settlementEvent) {
        throw conflict(
          "SETTLEMENT_EVENT_NOT_FOUND",
          "SettlementApplied event was not found in receipt",
        );
      }

      const confirmed = this.ledger.applyIndexedSettlement(
        settlementEvent.userAddress,
        settlementEvent.amountDelta,
        settlementEvent.newBalance,
        txHash,
        undefined,
        settlementEvent.settlementId,
        settlementEvent.reasonHash,
        {
          blockNumber: receipt.blockNumber.toString(),
          eventName: "SettlementApplied",
          contractAddress: vaultAddress,
        },
      );

      this.ledger.consumeSignedIntents(
        confirmed.settlementId,
        confirmed.signedIntentIds,
      );

      this.logger.info(
        `Settlement tx confirmed for ${request.userAddress}: amountDelta=${settlementEvent.amountDelta}, newBalance=${settlementEvent.newBalance}, settlementId=${settlementEvent.settlementId}, reasonHash=${settlementEvent.reasonHash}, txHash=${txHash}`,
      );

      const portfolio = this.ledger.snapshot(
        request.userAddress,
        (symbol) => this.marketData.getQuote(symbol).price,
        this.appConfig.maxLeverage,
      );

      return { settlement: confirmed, portfolio };
    } catch (error) {
      this.ledger.clearOnchainSettlementInFlight(request.userAddress);
      if (error instanceof Error && "statusCode" in error) throw error;

      const message = error instanceof Error ? error.message : String(error);
      throw conflict("SETTLEMENT_TX_FAILED", message);
    }
  }

  async settleUser(
    userAddress: HexAddress,
    onSubmitted?: SettlementSubmittedHandler,
  ): Promise<SettlementResult> {
    return this.submitSettlement(
      this.buildTradingPnlSettlementRequest(userAddress),
      onSubmitted,
    );
  }

  buildTradingPnlSettlementRequest(userAddress: HexAddress): SettlementRequest {
    const state = this.ledger.getOrCreate(userAddress);
    const amountDelta = roundMoney(state.pendingSettlementPnl);

    if (amountDelta === 0) {
      throw conflict(
        "NO_PENDING_SETTLEMENT",
        "User has no pending realized P&L to settle",
      );
    }

    const audit = buildTradingPnlAuditData(state, amountDelta);
    const signedIntentIds = this.ledger
      .listVerifiedSignedIntents(userAddress)
      .filter((intent) => intent.appId === "trading-example")
      .filter((intent) => intent.intentType === "TRADING_ORDER")
      .filter((intent) => intent.status === "VERIFIED")
      .map((intent) => intent.id)
      .sort();

    return {
      userAddress: getAddress(state.userAddress) as HexAddress,
      appId: "trading-example",
      settlementType: "TRADING_PNL",
      amountDelta: amountDelta.toString(),
      reasonHash: audit.reasonHash,
      referenceIds: audit.tradeIds,
      signedIntentIds,
      metadata: {
        symbols: audit.symbols,
        sequence: audit.sequence,
        createdAt: audit.createdAt,
        realizedPnl: amountDelta,
      },
    };
  }

  getSettlement(settlementId: Hex): SettlementRecord {
    const normalizedSettlementId = settlementId.toLowerCase();
    for (const userAddress of this.ledger.listKnownUsers()) {
      const settlement = this.ledger
        .getOrCreate(userAddress)
        .settlements.find(
          (record) =>
            record.settlementId.toLowerCase() === normalizedSettlementId,
        );
      if (settlement) return settlement;
    }
    throw notFound(
      "SETTLEMENT_NOT_FOUND",
      `Settlement not found: ${settlementId}`,
    );
  }

  getSettlementReport(settlementId: Hex): SettlementAuditReport {
    const settlement = this.getSettlement(settlementId);
    const state = this.ledger.getOrCreate(settlement.userAddress);
    const portfolio = this.ledger.snapshot(
      settlement.userAddress,
      (symbol) => this.marketData.getQuote(symbol).price,
      this.appConfig.maxLeverage,
    );
    const relatedTrades = state.trades.filter((trade) =>
      settlement.referenceIds.includes(trade.tradeId),
    );
    const linkedSignedIntents = settlement.signedIntentIds
      .map((intentId) => this.ledger.getSignedIntentById(intentId))
      .filter((intent): intent is StoredSignedIntent => Boolean(intent))
      .map(toLinkedSignedIntentReport);
    const signedIntentIds = linkedSignedIntents.map((intent) => intent.id);
    const audit = buildSettlementAuditMetadata(settlement.metadata);

    const report: SettlementAuditReport = {
      settlementId: settlement.settlementId,
      userAddress: settlement.userAddress,
      appId: settlement.appId,
      settlementType: settlement.settlementType,
      amountDelta: settlement.amountDelta,
      accounting: {
        amountDeltaMicroUsdc: parseSettlementAmount(
          settlement.amountDelta,
        ).microUsdc.toString(),
        formattedAmountDelta: parseSettlementAmount(settlement.amountDelta)
          .formatted,
        storageModel: "DECIMAL_API_WITH_INTEGER_CONTRACT_UNITS",
      },
      reasonHash: settlement.reasonHash,
      referenceIds: [...settlement.referenceIds],
      ...(settlement.metadata === undefined
        ? {}
        : { metadata: settlement.metadata }),
      offChainCalculation: {
        source: "gateway-ledger",
        reasonHash: settlement.reasonHash,
        referenceIds: [...settlement.referenceIds],
        ...(settlement.metadata === undefined
          ? {}
          : { metadata: settlement.metadata }),
        portfolioTimestamp: portfolio.ts,
      },
      signedIntentIds,
      linkedSignedIntents,
      audit,
      onChain: settlement.onChain,
      status: settlement.status,
      createdAt: settlement.createdAt,
      confirmedAt: settlement.confirmedAt,
    };

    if (settlement.settlementType === "TRADING_PNL") {
      report.trading = buildTradingSettlementSummary(
        relatedTrades,
        settlement.amountDelta,
      );
    }

    return report;
  }

  private prepareSettlementRequest(
    request: NormalizedSettlementRequest,
    authContext: SubmitSettlementAuthContext,
  ): NormalizedSettlementRequest {
    const linkedIntents = this.validateSettlementSignedIntents(
      request,
      authContext,
    );
    const metadata = decorateSettlementMetadata(
      request.metadata,
      authContext,
      linkedIntents.length,
    );

    return {
      ...request,
      metadata,
    };
  }

  private validateSettlementSignedIntents(
    request: NormalizedSettlementRequest,
    authContext: SubmitSettlementAuthContext,
  ): StoredSignedIntent[] {
    if (authContext.kind === "app" && request.signedIntentIds.length === 0) {
      throw conflict(
        "SIGNED_INTENTS_REQUIRED_FOR_APP_SETTLEMENT",
        "App-authenticated settlements must include at least one verified signedIntentId",
      );
    }

    const uniqueIds = new Set(request.signedIntentIds);
    if (uniqueIds.size !== request.signedIntentIds.length) {
      throw conflict(
        "DUPLICATE_SIGNED_INTENT_ID",
        "signedIntentIds must not contain duplicates",
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const intents: StoredSignedIntent[] = [];
    for (const signedIntentId of request.signedIntentIds) {
      const intent = this.ledger.getSignedIntentById(signedIntentId);
      if (!intent) {
        throw conflict(
          "SIGNED_INTENT_NOT_FOUND",
          `Signed intent not found: ${signedIntentId}`,
        );
      }

      if (intent.status === "CONSUMED") {
        throw conflict(
          "SIGNED_INTENT_ALREADY_CONSUMED",
          `Signed intent has already been consumed: ${signedIntentId}`,
        );
      }

      if (intent.status === "EXPIRED") {
        throw conflict(
          "SIGNED_INTENT_EXPIRED",
          `Signed intent is expired: ${signedIntentId}`,
        );
      }

      if (intent.status !== "VERIFIED") {
        throw conflict(
          "SIGNED_INTENT_NOT_VERIFIED",
          `Signed intent is not verified: ${signedIntentId}`,
        );
      }

      if (getAddress(intent.userAddress) !== getAddress(request.userAddress)) {
        throw conflict(
          "SIGNED_INTENT_USER_MISMATCH",
          "Signed intent belongs to a different userAddress",
        );
      }

      if (intent.appId !== request.appId) {
        throw conflict(
          "SIGNED_INTENT_APP_MISMATCH",
          "Signed intent appId does not match settlement appId",
        );
      }

      if (intent.deadline < now) {
        this.ledger.expireSignedIntent(intent.id);
        throw conflict(
          "SIGNED_INTENT_EXPIRED",
          `Signed intent deadline has passed: ${signedIntentId}`,
        );
      }

      intents.push(intent);
    }

    return intents;
  }

  private async loadUsableContracts(): Promise<ContractsConfig> {
    const contracts = await loadContractsConfig(this.appConfig.contractsFile);
    if (!hasUsableVaultDeployment(contracts)) {
      throw conflict(
        "CONTRACT_DEPLOYMENT_NOT_READY",
        `${this.appConfig.contractsFile} does not contain a deployed CollateralVault address and ABI yet. Run npm run deploy:local first.`,
      );
    }
    return contracts;
  }

  private createClients(contracts: ContractsConfig): {
    publicClient: PublicClient;
    walletClient: WalletClient;
    operatorAddress: Address;
    operatorAccount: Account;
  } {
    const privateKey = resolveOperatorPrivateKey(
      this.appConfig.operatorPrivateKey,
    );
    const account = privateKeyToAccount(privateKey);
    const operatorAddress = getAddress(account.address);

    const chain = defineChain({
      id: this.appConfig.chainId,
      name: contracts.network ?? "Local Hardhat",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [this.appConfig.rpcUrl] } },
    });

    const transport = http(this.appConfig.rpcUrl);
    return {
      publicClient: createPublicClient({ chain, transport }),
      walletClient: createWalletClient({ account, chain, transport }),
      operatorAddress,
      operatorAccount: account,
    };
  }
}

function parseSettlementAppliedEvent(
  abi: Abi,
  logs: readonly unknown[],
  targetUserAddress: HexAddress,
): SettlementEvent | null {
  const parsedLogs = parseEventLogs({
    abi,
    logs: logs as Parameters<typeof parseEventLogs>[0]["logs"],
    eventName: "SettlementApplied",
  });

  const target = getAddress(targetUserAddress);
  for (const log of parsedLogs) {
    const args = log.args as {
      user?: Address;
      amountDelta?: bigint;
      newBalance?: bigint;
      settlementId?: Hex;
      reasonHash?: Hex;
    };
    if (
      !args.user ||
      typeof args.amountDelta !== "bigint" ||
      typeof args.newBalance !== "bigint" ||
      typeof args.settlementId !== "string" ||
      typeof args.reasonHash !== "string"
    ) {
      continue;
    }
    const userAddress = getAddress(args.user);
    if (userAddress !== target) continue;

    return {
      userAddress,
      amountDelta: fromMicroUsdc(args.amountDelta),
      newBalance: fromMicroUsdc(args.newBalance),
      settlementId: args.settlementId,
      reasonHash: args.reasonHash,
    };
  }

  return null;
}

function buildTradingSettlementSummary(
  relatedTrades: Trade[],
  amountDelta: number,
): NonNullable<SettlementAuditReport["trading"]> {
  const buyTrades = relatedTrades.filter((trade) => trade.side === "BUY");
  const sellTrades = relatedTrades.filter((trade) => trade.side === "SELL");
  const entryQuantity = buyTrades.reduce(
    (sum, trade) => decimalAdd(sum, trade.quantity),
    0,
  );
  const exitQuantity = sellTrades.reduce(
    (sum, trade) => decimalAdd(sum, trade.quantity),
    0,
  );
  const grossPnl = relatedTrades.reduce(
    (sum, trade) => decimalAdd(sum, trade.realizedPnlDelta),
    0,
  );
  const fees = relatedTrades.reduce(
    (sum, trade) => decimalAdd(sum, trade.fee),
    0,
  );
  const netPnl = decimalSub(grossPnl, fees);

  return {
    symbol: relatedTrades[0]?.symbol ?? null,
    entryPrice: weightedAveragePrice(buyTrades, entryQuantity),
    exitPrice: weightedAveragePrice(sellTrades, exitQuantity),
    quantity: roundMoney(exitQuantity || entryQuantity),
    grossPnl,
    fees,
    netPnl: roundMoney(netPnl || amountDelta),
    tradeIds: relatedTrades.map((trade) => trade.tradeId).sort(),
  };
}

function weightedAveragePrice(
  trades: Trade[],
  quantity: number,
): number | null {
  if (quantity <= 0) return null;
  const totalNotional = trades.reduce(
    (sum, trade) =>
      decimalAdd(sum, calculateNotional(trade.quantity, trade.price)),
    0,
  );
  return decimalDiv(totalNotional, quantity);
}

function decorateSettlementMetadata(
  metadata: Record<string, unknown> | undefined,
  authContext: SubmitSettlementAuthContext,
  linkedIntentCount: number,
): Record<string, unknown> | undefined {
  const base = metadata === undefined ? {} : { ...metadata };
  const audit = {
    authorization: authContext.kind,
    linkedIntentCount,
    trustedOperatorSettlement:
      (authContext.kind === "admin" || authContext.kind === "internal") &&
      linkedIntentCount === 0,
    warnings:
      (authContext.kind === "admin" || authContext.kind === "internal") &&
      linkedIntentCount === 0
        ? [
            "Settlement was authorized by the trusted operator/admin path without linked signed intents.",
          ]
        : [],
  };

  return { ...base, settlementAudit: audit };
}

function buildSettlementAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): SettlementAuditReport["audit"] {
  const rawAudit = metadata?.settlementAudit;
  if (!rawAudit || typeof rawAudit !== "object" || Array.isArray(rawAudit)) {
    return {
      authorization: "unknown",
      trustedOperatorSettlement: false,
      warnings: [],
    };
  }

  const audit = rawAudit as Record<string, unknown>;
  const authorization =
    audit.authorization === "admin" ||
    audit.authorization === "app" ||
    audit.authorization === "internal"
      ? audit.authorization
      : "unknown";
  const warnings = Array.isArray(audit.warnings)
    ? audit.warnings.map((warning) => String(warning))
    : [];

  return {
    authorization,
    trustedOperatorSettlement: audit.trustedOperatorSettlement === true,
    warnings,
  };
}

function toLinkedSignedIntentReport(
  intent: StoredSignedIntent,
): LinkedSignedIntentReport {
  return {
    id: intent.id,
    appId: intent.appId,
    intentType: intent.intentType,
    payloadHash: intent.payloadHash,
    nonce: intent.nonce,
    signer: intent.signer,
    userAddress: intent.userAddress,
    deadline: intent.deadline,
    status: intent.status,
    createdAt: intent.createdAt,
    consumedAt: intent.consumedAt ?? null,
    consumedBySettlementId: intent.consumedBySettlementId ?? null,
  };
}

export function buildSettlementReasonHash(input: {
  userAddress: HexAddress;
  appId: string;
  settlementType: string;
  amountDelta: string | number;
  referenceIds: string[];
  signedIntentIds: string[];
  metadataHash?: HexString;
}): HexString {
  return keccak256(
    toHex(
      stableStringify({
        userAddress: getAddress(input.userAddress),
        appId: input.appId.trim(),
        settlementType: input.settlementType.trim().toUpperCase(),
        amountDelta: input.amountDelta.toString(),
        referenceIds: [...input.referenceIds].sort(),
        signedIntentIds: [...input.signedIntentIds].sort(),
        metadataHash: input.metadataHash ?? null,
      }),
    ),
  ) as HexString;
}

function normalizeSettlementRequest(
  request: SettlementRequest,
): NormalizedSettlementRequest {
  const amountDelta = Number(request.amountDelta);
  if (!Number.isFinite(amountDelta)) {
    throw conflict(
      "INVALID_SETTLEMENT_AMOUNT",
      "amountDelta must be a finite decimal string",
    );
  }

  return {
    userAddress: getAddress(request.userAddress) as HexAddress,
    appId: request.appId.trim(),
    settlementType: request.settlementType.trim().toUpperCase(),
    amountDelta: roundMoney(amountDelta),
    reasonHash: request.reasonHash.toLowerCase() as HexString,
    referenceIds: [...request.referenceIds],
    signedIntentIds: [...request.signedIntentIds],
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  };
}

function buildSettlementId(request: NormalizedSettlementRequest): Hex {
  return keccak256(
    toHex(
      stableStringify({
        type: "collateral-settlement-gateway-settlement",
        userAddress: getAddress(request.userAddress),
        appId: request.appId,
        settlementType: request.settlementType,
        amountDelta: request.amountDelta,
        reasonHash: request.reasonHash,
        referenceIds: request.referenceIds,
        signedIntentIds: request.signedIntentIds,
        metadata: request.metadata ?? null,
        sequence: nanoid(16),
        timestamp: new Date().toISOString(),
      }),
    ),
  );
}

function buildTradingPnlAuditData(
  state: UserLedgerState,
  realizedPnl: number,
): {
  reasonHash: Hex;
  createdAt: string;
  sequence: string;
  tradeIds: string[];
  symbols: string[];
} {
  const createdAt = new Date().toISOString();
  const sequence = nanoid(16);
  const tradeIds = settlementTradeIds(state.trades);
  const symbols = [
    ...new Set(state.trades.map((trade) => trade.symbol).filter(Boolean)),
  ].sort();
  const reasonPayload = {
    appId: "trading-example",
    settlementType: "TRADING_PNL",
    userAddress: getAddress(state.userAddress),
    symbols,
    tradeIds,
    amountDelta: roundMoney(realizedPnl),
    sequence,
    timestamp: createdAt,
  };

  const reasonHash = keccak256(toHex(stableStringify(reasonPayload)));
  return { reasonHash, createdAt, sequence, tradeIds, symbols };
}

function settlementTradeIds(trades: Trade[]): string[] {
  const closingTrades = trades.filter(
    (trade) => trade.realizedPnlDelta !== 0 || trade.fee !== 0,
  );
  return closingTrades.map((trade) => trade.tradeId).sort();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function resolveOperatorPrivateKey(rawPrivateKey: string | null): Hex {
  const privateKey = rawPrivateKey?.trim() || LOCAL_HARDHAT_PRIVATE_KEY;
  const normalized = privateKey.startsWith("0x")
    ? privateKey
    : `0x${privateKey}`;
  return normalized as Hex;
}
