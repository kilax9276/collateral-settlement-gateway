import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
} from "viem";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { ReconciliationService } from "../core/reconciliation/reconciliationService.js";
import type { BlockchainIndexer } from "../core/blockchain/blockchainIndexer.js";
import type { AppStorage } from "../core/storage/index.js";
import type { StoredChainEvent } from "../core/storage/types.js";
import type { Ledger } from "../core/storage/gatewayLedger.js";
import type { MarketDataService } from "../examples/trading/marketData.js";
import { userAddressParamsSchema } from "../utils/validation.js";
import {
  hasUsableVaultDeployment,
  loadContractsConfig,
  normalizeContractsConfig,
} from "../utils/contracts.js";
import type {
  GatewayMetricsReport,
  ReconciliationStatus,
  SystemHealthReport,
} from "../types/domain.js";
import type { ContractsConfig } from "../types/contracts.js";
import { requireAdminAuth } from "../core/auth/adminAuth.js";
import { fromMicroUsdc, roundMoney } from "../core/money/money.js";
import {
  addressParamSchema,
  errorResponses,
  gatewayMetricsSchema,
  reconciliationReportSchema,
  systemHealthSchema,
} from "../docs/openapiSchemas.js";

const adminListQuerySchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
};

export async function adminRoutes(
  app: FastifyInstance,
  reconciliationService: ReconciliationService,
  blockchainIndexer: BlockchainIndexer,
  storage: AppStorage,
  appConfig: AppConfig,
  ledger: Ledger,
  marketData: MarketDataService,
): Promise<void> {
  const requireAdmin = requireAdminAuth(appConfig);

  app.get(
    "/admin/reconciliation/:userAddress",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Reconciliation"],
        summary: "Reconcile one user",
        description:
          "Compares the user's on-chain Vault balance and pending withdrawals with off-chain gateway ledger state, pending realized settlement amount, open example positions and settlement history. Returns OK, WARNING or MISMATCH with issue codes.",
        params: addressParamSchema("userAddress"),
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "User reconciliation report",
            ...reconciliationReportSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { userAddress } = userAddressParamsSchema.parse(request.params);
      return reconciliationService.reconcileUser(userAddress);
    },
  );

  app.get(
    "/admin/reconciliation",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Reconciliation"],
        summary: "Reconcile all known users",
        description:
          "Returns reconciliation reports for every user known to the off-chain gateway ledger/storage.",
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "All reconciliation reports",
            type: "object",
            additionalProperties: true,
          },
          ...errorResponses,
        },
      },
    },
    async () => reconciliationService.reconcileAll(),
  );

  app.get(
    "/admin/system-health",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Admin"],
        summary: "Get system health and infrastructure status",
        description:
          "Returns operator-facing runtime status: configured chain id, Vault address, indexer enabled/started state, last processed block and storage backend health.",
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: { description: "System health report", ...systemHealthSchema },
          ...errorResponses,
        },
      },
    },
    async (): Promise<SystemHealthReport> => {
      const indexer = blockchainIndexer.status();
      const contracts = await readContracts(appConfig);
      const vaultAddress =
        contracts?.collateralVault.address ?? indexer.vaultAddress;
      return {
        chainId: appConfig.chainId,
        vaultAddress,
        indexer: {
          enabled: indexer.enabled,
          started: indexer.started,
          lastProcessedBlock: indexer.lastProcessedBlock,
        },
        sqlite: storageHealth(storage, appConfig),
        ts: new Date().toISOString(),
      };
    },
  );

  app.get(
    "/admin/gateway-metrics",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Admin"],
        summary: "Get operator console gateway metrics",
        description:
          "Aggregates chain/indexer/storage status, Vault accounting when available, ledger totals, pending workflows and reconciliation summary for the Operator Console.",
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "Gateway metrics report",
            ...gatewayMetricsSchema,
          },
          ...errorResponses,
        },
      },
    },
    async (): Promise<GatewayMetricsReport> => {
      const contracts = await readContracts(appConfig);
      const vaultAccounting = await readVaultAccounting(appConfig, contracts);
      const indexer = blockchainIndexer.status();
      const portfolios = ledger
        .listKnownUsers()
        .map((userAddress) =>
          ledger.snapshot(
            userAddress,
            (symbol) => marketData.getQuote(symbol).price,
            appConfig.maxLeverage,
          ),
        );
      const reconciliation = await reconciliationService.reconcileAll();
      const reconciliationSummary = countReconciliationStatuses(
        reconciliation.reports.map((report) => report.status),
      );
      const pendingSettlementRecords =
        storage.settlementRepository.listPendingSettlements().length;
      const pendingPnlUsers = portfolios.filter(
        (portfolio) => Math.abs(portfolio.pendingSettlementPnl) >= 0.000001,
      ).length;
      const openPositions = portfolios.reduce(
        (sum, portfolio) =>
          sum +
          portfolio.positions.filter((position) => position.quantity !== 0)
            .length,
        0,
      );
      const latestBlock = await readLatestBlock(appConfig, contracts);
      const lagBlocks = calculateLagBlocks(
        indexer.lastProcessedBlock,
        latestBlock,
      );

      return {
        chainId: appConfig.chainId,
        vaultAddress:
          contracts?.collateralVault.address ?? indexer.vaultAddress ?? null,
        operatorAddress: contracts?.operator ?? null,
        indexer: {
          enabled: indexer.enabled,
          status: indexer.enabled
            ? indexer.started
              ? "running"
              : "stopped"
            : "disabled",
          lastProcessedBlock: indexer.lastProcessedBlock,
          lagBlocks,
        },
        storage: storageHealth(storage, appConfig),
        collateral: {
          totalUsers: portfolios.length,
          totalUserCollateral: roundMoney(
            portfolios.reduce(
              (sum, portfolio) => sum + portfolio.collateral,
              0,
            ),
          ),
          totalLiabilities: vaultAccounting.totalLiabilities,
          insuranceBalance: vaultAccounting.insuranceFundBalance,
        },
        operations: {
          pendingWithdrawals: portfolios.filter(
            (portfolio) => portfolio.pendingWithdrawals > 0,
          ).length,
          pendingSettlements: pendingSettlementRecords + pendingPnlUsers,
          recentSettlements:
            storage.settlementRepository.listRecentSettlements(20).length,
          recentSignedIntents:
            storage.signedIntentsRepository.listRecentIntents(20).length,
        },
        tradingExample: {
          openPositions,
          supportedSymbols: appConfig.supportedSymbols,
        },
        reconciliationSummary,
        ts: new Date().toISOString(),
      };
    },
  );

  app.get(
    "/admin/recent-events",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Admin"],
        summary: "List recent indexed chain events",
        querystring: adminListQuerySchema,
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "Recent chain events",
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { limit } = parseLimitQuery(request.query);
      return storage.chainEventsRepository
        .listRecentEvents(limit)
        .map(toRecentChainEventResponse);
    },
  );

  app.get(
    "/admin/recent-settlements",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Admin"],
        summary: "List recent settlement records",
        querystring: adminListQuerySchema,
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "Recent settlements",
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { limit } = parseLimitQuery(request.query);
      return storage.settlementRepository.listRecentSettlements(limit);
    },
  );

  app.get(
    "/admin/recent-intents",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Admin"],
        summary: "List recent verified signed intents",
        querystring: adminListQuerySchema,
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "Recent signed intents",
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { limit } = parseLimitQuery(request.query);
      return storage.signedIntentsRepository.listRecentIntents(limit);
    },
  );

  app.get(
    "/admin/pending-withdrawals",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Admin"],
        summary: "List users with pending withdrawals",
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "Pending withdrawals",
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          ...errorResponses,
        },
      },
    },
    async () =>
      ledger
        .listKnownUsers()
        .map((userAddress) =>
          ledger.snapshot(
            userAddress,
            (symbol) => marketData.getQuote(symbol).price,
            appConfig.maxLeverage,
          ),
        )
        .filter((portfolio) => portfolio.pendingWithdrawals > 0)
        .map((portfolio) => ({
          userAddress: portfolio.userAddress,
          amount: portfolio.pendingWithdrawals,
          approvedWithdrawals: portfolio.approvedWithdrawals,
          status: "PENDING_OPERATOR_APPROVAL",
          ts: portfolio.ts,
        })),
  );

  app.get(
    "/admin/pending-settlements",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Admin"],
        summary: "List pending settlement workflows",
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: {
            description: "Pending settlements",
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          ...errorResponses,
        },
      },
    },
    async () => {
      const onChainSubmitted = storage.settlementRepository
        .listPendingSettlements()
        .map((settlement) => ({
          ...settlement,
          pendingReason: "ONCHAIN_SUBMITTED",
        }));
      const pendingPnl = ledger
        .listKnownUsers()
        .map((userAddress) =>
          ledger.snapshot(
            userAddress,
            (symbol) => marketData.getQuote(symbol).price,
            appConfig.maxLeverage,
          ),
        )
        .filter(
          (portfolio) => Math.abs(portfolio.pendingSettlementPnl) >= 0.000001,
        )
        .map((portfolio) => ({
          userAddress: portfolio.userAddress,
          appId: "trading-example",
          settlementType: "TRADING_PNL",
          amountDelta: portfolio.pendingSettlementPnl,
          pendingReason: "PENDING_REALIZED_PNL",
          ts: portfolio.ts,
        }));
      return [...onChainSubmitted, ...pendingPnl];
    },
  );
}

async function readContracts(
  appConfig: AppConfig,
): Promise<ContractsConfig | null> {
  try {
    return normalizeContractsConfig(
      await loadContractsConfig(appConfig.contractsFile),
    );
  } catch {
    return null;
  }
}

async function readVaultAccounting(
  appConfig: AppConfig,
  contracts: ContractsConfig | null,
): Promise<{
  insuranceFundBalance: number | null;
  totalLiabilities: number | null;
}> {
  if (!contracts || !hasUsableVaultDeployment(contracts)) {
    return { insuranceFundBalance: null, totalLiabilities: null };
  }

  try {
    const vaultAddress = getAddress(
      contracts.collateralVault.address as Address,
    );
    const vaultAbi = contracts.collateralVault.abi as Abi;
    const chain = defineChain({
      id: appConfig.chainId,
      name: contracts.network ?? "Local Hardhat",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [appConfig.rpcUrl] } },
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(appConfig.rpcUrl),
    });
    const [insuranceBalance, totalLiabilities] = await Promise.all([
      publicClient.readContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: "insuranceBalance",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName: "totalLiabilities",
      }) as Promise<bigint>,
    ]);
    return {
      insuranceFundBalance: fromMicroUsdc(insuranceBalance),
      totalLiabilities: fromMicroUsdc(totalLiabilities),
    };
  } catch {
    return { insuranceFundBalance: null, totalLiabilities: null };
  }
}

async function readLatestBlock(
  appConfig: AppConfig,
  contracts: ContractsConfig | null,
): Promise<string | null> {
  if (!contracts || !hasUsableVaultDeployment(contracts)) return null;

  try {
    const chain = defineChain({
      id: appConfig.chainId,
      name: contracts.network ?? "Local Hardhat",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [appConfig.rpcUrl] } },
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(appConfig.rpcUrl),
    });
    return (await publicClient.getBlockNumber()).toString();
  } catch {
    return null;
  }
}

function calculateLagBlocks(
  lastProcessedBlock: string | null,
  latestBlock: string | null,
): number | null {
  if (!lastProcessedBlock || !latestBlock) return null;
  const latest = BigInt(latestBlock);
  const last = BigInt(lastProcessedBlock);
  return Number(latest > last ? latest - last : 0n);
}

function storageHealth(storage: AppStorage, appConfig: AppConfig) {
  return {
    driver: storage.kind,
    status: "OK" as const,
    ...(storage.kind === "sqlite" ? { path: appConfig.sqlitePath } : {}),
  };
}

function countReconciliationStatuses(statuses: ReconciliationStatus[]) {
  return statuses.reduce<Record<ReconciliationStatus, number>>(
    (summary, status) => {
      summary[status] += 1;
      return summary;
    },
    { OK: 0, WARNING: 0, MISMATCH: 0 },
  );
}

function parseLimitQuery(query: unknown): { limit: number } {
  const rawLimit = (query as { limit?: unknown } | undefined)?.limit;
  const parsed = Number(rawLimit ?? 20);
  return {
    limit: Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 20,
  };
}

function toRecentChainEventResponse(event: StoredChainEvent) {
  let payload: unknown = event.payloadJson;
  try {
    payload = JSON.parse(event.payloadJson) as unknown;
  } catch {
    // Keep raw payloadJson if historical storage contains invalid JSON.
  }
  return { ...event, payload };
}
