import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { HexAddress, RealtimeEvent } from "./types/domain.js";
import { healthRoutes } from "./admin/systemHealth.js";
import { authRoutes } from "./core/auth/authRoutes.js";
import { contractRoutes } from "./core/collateral/collateralRoutes.js";
import { marketRoutes } from "./examples/trading/tradingMarketRoutes.js";
import { portfolioRoutes } from "./examples/trading/tradingPortfolioRoutes.js";
import { orderRoutes } from "./examples/trading/tradingRoutes.js";
import { settlementRoutes } from "./core/settlement/settlementRoutes.js";
import { withdrawalRoutes } from "./core/withdrawals/withdrawalRoutes.js";
import { adminRoutes } from "./admin/adminRoutes.js";
import { dashboardRoutes } from "./demo/dashboardRoutes.js";
import { demoRoutes } from "./demo/demoRoutes.js";
import { Ledger } from "./core/storage/gatewayLedger.js";
import { createStorage, type AppStorage } from "./core/storage/index.js";
import { MarketDataService } from "./examples/trading/marketData.js";
import { SignedIntentService } from "./core/auth/signedIntentService.js";
import { SettlementService } from "./core/settlement/settlementService.js";
import { WithdrawalService } from "./core/withdrawals/withdrawalService.js";
import { RiskService } from "./core/risk/riskService.js";
import { ReconciliationService } from "./core/reconciliation/reconciliationService.js";
import { DemoService } from "./demo/demoScenario.js";
import { TradingEngine } from "./examples/trading/tradingEngine.js";
import { BlockchainIndexer } from "./core/blockchain/blockchainIndexer.js";
import { WebSocketHub } from "./core/websocket/websocketHub.js";
import { AppError, formatErrorResponse } from "./utils/errors.js";
import { registerOpenApi } from "./docs/openapi.js";
import { warnAboutAdminAuthConfig } from "./core/auth/adminAuth.js";

export type BuildAppOptions = {
  logger?: boolean;
  seedBalances?: Record<HexAddress, number>;
  startIndexer?: boolean;
  storage?: AppStorage;
};

export async function buildApp(
  appConfig: AppConfig,
  options: BuildAppOptions = {},
) {
  const app = Fastify({
    logger: options.logger ?? true,
    ajv: { customOptions: { strict: false } },
  });
  warnAboutAdminAuthConfig(appConfig, app.log);
  const storage = options.storage ?? createStorage(appConfig);
  const ledger = new Ledger(storage);
  const wsHub = new WebSocketHub();
  const marketData = new MarketDataService(appConfig, {
    onQuote: (quote) => wsHub.publish({ type: "price:update", payload: quote }),
  });
  const riskService = new RiskService(ledger, marketData, appConfig);
  const tradingEngine = new TradingEngine(
    ledger,
    marketData,
    riskService,
    appConfig,
  );
  const signedIntentService = new SignedIntentService(ledger, appConfig);
  const settlementService = new SettlementService(
    ledger,
    marketData,
    appConfig,
  );
  const withdrawalService = new WithdrawalService(
    ledger,
    marketData,
    riskService,
    appConfig,
  );
  const reconciliationService = new ReconciliationService(
    ledger,
    marketData,
    appConfig,
  );
  const demoService = new DemoService(
    ledger,
    marketData,
    signedIntentService,
    tradingEngine,
    settlementService,
    withdrawalService,
    appConfig,
  );
  const blockchainIndexer = new BlockchainIndexer(
    ledger,
    marketData,
    appConfig,
    (event) => wsHub.publish(event as RealtimeEvent),
    app.log,
  );

  for (const [userAddress, amount] of Object.entries(
    options.seedBalances ?? {},
  ) as [HexAddress, number][]) {
    ledger.applyDeposit(userAddress, amount);
  }

  await marketData.start();

  await registerOpenApi(app, appConfig);
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    const maybeValidationError = error as {
      validation?: Array<{ instancePath?: string; message?: string }>;
      message?: string;
    };
    if (Array.isArray(maybeValidationError.validation)) {
      return reply.status(400).send(
        formatErrorResponse(
          "VALIDATION_ERROR",
          maybeValidationError.message ?? "Invalid request",
          maybeValidationError.validation.map((issue) => ({
            path: issue.instancePath ?? "",
            message: issue.message ?? "Invalid request",
          })),
        ),
      );
    }

    if (error instanceof ZodError) {
      return reply.status(400).send(
        formatErrorResponse(
          "VALIDATION_ERROR",
          "Invalid request",
          error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        ),
      );
    }

    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send(formatErrorResponse(error.code, error.message, error.details));
    }

    const message = error instanceof Error ? error.message : "Unexpected error";
    app.log.error(error);
    return reply
      .status(500)
      .send(formatErrorResponse("INTERNAL_ERROR", message));
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply
      .status(404)
      .send(formatErrorResponse("NOT_FOUND", "Route not found"));
  });

  app.get("/ws", { websocket: true, schema: { hide: true } }, (socket) => {
    wsHub.add(socket);
    const connectedEvent: RealtimeEvent = {
      type: "system:connected",
      payload: {
        message: "Connected to Collateral Settlement Gateway realtime stream",
        quotes: marketData.allQuotes(),
        ts: new Date().toISOString(),
      },
    };
    socket.send(JSON.stringify(connectedEvent));
  });

  await healthRoutes(app);
  await authRoutes(app, signedIntentService, appConfig);
  await contractRoutes(app, appConfig);
  await marketRoutes(app, marketData, appConfig);
  await portfolioRoutes(app, ledger, marketData, appConfig);
  await orderRoutes(app, tradingEngine, signedIntentService, wsHub);
  await settlementRoutes(app, settlementService, wsHub, appConfig);
  await withdrawalRoutes(app, withdrawalService, wsHub, appConfig);
  await adminRoutes(
    app,
    reconciliationService,
    blockchainIndexer,
    storage,
    appConfig,
    ledger,
    marketData,
  );
  await dashboardRoutes(app);

  if (appConfig.enableDemoRoutes) {
    await demoRoutes(app, demoService, wsHub, appConfig);
  }

  if (options.startIndexer ?? true) {
    try {
      await blockchainIndexer.start();
    } catch (error) {
      app.log.error(error);
      app.log.warn(
        "Backend started without blockchain indexer. Check RPC_URL and generated contract deployment metadata. Run npm run local:deploy to create backend/src/generated/contracts.json.",
      );
    }
  }

  app.addHook("onClose", async () => {
    await blockchainIndexer.stop();
    await marketData.stop();
    storage.close();
  });

  return {
    app,
    services: {
      ledger,
      marketData,
      wsHub,
      tradingEngine,
      riskService,
      signedIntentService,
      settlementService,
      withdrawalService,
      reconciliationService,
      demoService,
      blockchainIndexer,
      storage,
    },
  };
}
