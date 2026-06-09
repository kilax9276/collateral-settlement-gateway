import { config as loadEnv } from "dotenv";

loadEnv();

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = raw.trim();
  return value.length > 0 ? value : fallback;
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

export const config = {
  port: numberFromEnv("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",
  nodeEnv: process.env.NODE_ENV ?? "development",
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  chainId: numberFromEnv("CHAIN_ID", 31337),
  indexerEnabled: booleanFromEnv("INDEXER_ENABLED", true),
  indexerPollIntervalMs: numberFromEnv("INDEXER_POLL_INTERVAL_MS", 1000),
  contractsFile:
    process.env.CONTRACTS_FILE ?? "backend/src/generated/contracts.json",
  operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY ?? null,
  alicePrivateKey: process.env.ALICE_PRIVATE_KEY ?? null,
  gatewayAdminToken: stringFromEnv(
    "GATEWAY_ADMIN_TOKEN",
    "change-me-admin-token",
  ),
  gatewayAdminTokenConfigured: Boolean(process.env.GATEWAY_ADMIN_TOKEN?.trim()),
  registeredApps: stringFromEnv(
    "REGISTERED_APPS",
    "trading-example:change-me-trading-secret,fantasy-trading-app:change-me-external-secret",
  ),
  enableDemoRoutes: booleanFromEnv("ENABLE_DEMO_ROUTES", false),
  defaultSymbol: process.env.DEFAULT_SYMBOL ?? "BTC-USD",
  defaultBtcPrice: numberFromEnv("DEFAULT_BTC_PRICE", 65_000),
  marketDataProvider: stringFromEnv("MARKET_DATA_PROVIDER", "mock") as
    | "mock"
    | "coingecko"
    | "pyth",
  coinGeckoApiKey: process.env.COINGECKO_API_KEY ?? null,
  coinGeckoBaseUrl: stringFromEnv(
    "COINGECKO_BASE_URL",
    "https://api.coingecko.com/api/v3",
  ),
  pythPriceFeedId: process.env.PYTH_PRICE_FEED_ID ?? null,
  pythBaseUrl: stringFromEnv("PYTH_BASE_URL", "https://hermes.pyth.network"),
  maxLeverage: numberFromEnv("MAX_LEVERAGE", 5),
  maxPositionNotional: numberFromEnv("MAX_POSITION_NOTIONAL", 100_000),
  minCollateral: numberFromEnv("MIN_COLLATERAL", 0),
  maxPriceAgeMs: numberFromEnv("MAX_PRICE_AGE_MS", 60_000),
  supportedSymbols: listFromEnv("SUPPORTED_SYMBOLS", ["BTC-USD"]),
  takerFeeBps: numberFromEnv("TAKER_FEE_BPS", 5),
  quoteTickMs: numberFromEnv("QUOTE_TICK_MS", 1000),
  storageDriver: (process.env.STORAGE_DRIVER ?? "sqlite") as
    | "sqlite"
    | "memory",
  sqlitePath: process.env.SQLITE_PATH ?? "backend/data/app.db",
};

export type AppConfig = typeof config;
