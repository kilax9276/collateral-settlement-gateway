import type { AppConfig } from "../../config.js";
import type { Quote } from "../../types/domain.js";
import { badRequest, conflict } from "../../utils/errors.js";
import { roundMoney } from "../../core/money/money.js";

export type MarketDataProvider = {
  getPrice(symbol: string): Promise<Quote>;
  start(onQuote: (quote: Quote) => void): Promise<void>;
  stop(): Promise<void>;
};

export type MarketDataProviderName = "mock" | "coingecko" | "pyth";

export class MockMarketDataProvider implements MarketDataProvider {
  private readonly quotes = new Map<string, Quote>();
  private onQuote?: (quote: Quote) => void;

  constructor(defaultSymbol: string, defaultPrice: number) {
    if (!Number.isFinite(defaultPrice) || defaultPrice <= 0) {
      throw badRequest(
        "INVALID_DEFAULT_PRICE",
        "Default price must be positive",
      );
    }
    this.quotes.set(
      defaultSymbol.toUpperCase(),
      createQuote(defaultSymbol, defaultPrice, "mock"),
    );
  }

  async start(onQuote: (quote: Quote) => void): Promise<void> {
    this.onQuote = onQuote;
    for (const quote of this.quotes.values()) {
      onQuote(quote);
    }
  }

  async stop(): Promise<void> {
    this.onQuote = undefined;
  }

  async getPrice(symbol: string): Promise<Quote> {
    const quote = this.quotes.get(symbol.toUpperCase());
    if (!quote)
      throw badRequest(
        "SYMBOL_NOT_CONFIGURED",
        `Mock price is not configured: ${symbol}`,
      );
    return quote;
  }

  setPrice(
    symbol: string,
    price: number,
    timestamp = new Date().toISOString(),
    confidence?: number,
  ): Quote {
    if (!Number.isFinite(price) || price <= 0) {
      throw badRequest("INVALID_PRICE", "Price must be positive");
    }

    const normalized = symbol.toUpperCase();
    if (!this.quotes.has(normalized)) {
      throw badRequest(
        "SYMBOL_NOT_CONFIGURED",
        `Mock price is not configured: ${symbol}`,
      );
    }

    const quote = createQuote(normalized, price, "mock", timestamp, confidence);
    this.quotes.set(normalized, quote);
    this.onQuote?.(quote);
    return quote;
  }

  initialQuotes(): Quote[] {
    return [...this.quotes.values()];
  }
}

export class CoinGeckoMarketDataProvider implements MarketDataProvider {
  private interval?: NodeJS.Timeout;
  private onQuote?: (quote: Quote) => void;

  constructor(private readonly appConfig: AppConfig) {}

  async start(onQuote: (quote: Quote) => void): Promise<void> {
    this.onQuote = onQuote;
    await this.refreshSupportedSymbols();
    this.interval = setInterval(() => {
      void this.refreshSupportedSymbols();
    }, this.appConfig.quoteTickMs);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.onQuote = undefined;
  }

  async getPrice(symbol: string): Promise<Quote> {
    const normalized = symbol.toUpperCase();
    const mapping = mapCoinGeckoSymbol(normalized);
    if (!mapping) {
      throw badRequest(
        "UNSUPPORTED_SYMBOL",
        `CoinGecko provider has no mapping for ${symbol}`,
      );
    }

    const url = new URL(`${this.appConfig.coinGeckoBaseUrl}/simple/price`);
    url.searchParams.set("ids", mapping.coinId);
    url.searchParams.set("vs_currencies", mapping.vsCurrency);

    const headers: Record<string, string> = {};
    if (this.appConfig.coinGeckoApiKey) {
      headers["x-cg-demo-api-key"] = this.appConfig.coinGeckoApiKey;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw conflict(
        "MARKET_DATA_UNAVAILABLE",
        `CoinGecko request failed: ${response.status}`,
      );
    }

    const raw = (await response.json()) as Record<
      string,
      Record<string, number>
    >;
    const price = raw[mapping.coinId]?.[mapping.vsCurrency];
    if (!Number.isFinite(price) || price <= 0) {
      throw conflict(
        "MARKET_DATA_UNAVAILABLE",
        `CoinGecko response has no price for ${symbol}`,
      );
    }

    return createQuote(
      normalized,
      price,
      "coingecko",
      new Date().toISOString(),
      undefined,
      raw,
    );
  }

  private async refreshSupportedSymbols(): Promise<void> {
    for (const symbol of this.appConfig.supportedSymbols) {
      try {
        const quote = await this.getPrice(symbol);
        this.onQuote?.(quote);
      } catch {
        // Skeleton provider: keep the backend alive when third-party market data is unavailable.
      }
    }
  }
}

export class PythMarketDataProvider implements MarketDataProvider {
  private interval?: NodeJS.Timeout;
  private onQuote?: (quote: Quote) => void;

  constructor(private readonly appConfig: AppConfig) {}

  async start(onQuote: (quote: Quote) => void): Promise<void> {
    this.onQuote = onQuote;
    await this.refreshSupportedSymbols();
    this.interval = setInterval(() => {
      void this.refreshSupportedSymbols();
    }, this.appConfig.quoteTickMs);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.onQuote = undefined;
  }

  async getPrice(symbol: string): Promise<Quote> {
    const normalized = symbol.toUpperCase();
    const feedId = this.appConfig.pythPriceFeedId;
    if (!feedId) {
      throw conflict(
        "MARKET_DATA_NOT_CONFIGURED",
        "PYTH_PRICE_FEED_ID is required for pyth",
      );
    }

    const url = new URL(
      `${this.appConfig.pythBaseUrl}/v2/updates/price/latest`,
    );
    url.searchParams.append("ids[]", feedId);

    const response = await fetch(url);
    if (!response.ok) {
      throw conflict(
        "MARKET_DATA_UNAVAILABLE",
        `Pyth request failed: ${response.status}`,
      );
    }

    const raw = (await response.json()) as PythLatestPriceResponse;
    const parsed = parsePythPrice(raw);
    return createQuote(
      normalized,
      parsed.price,
      "pyth",
      new Date(parsed.publishTime * 1000).toISOString(),
      parsed.confidence,
      raw,
    );
  }

  private async refreshSupportedSymbols(): Promise<void> {
    for (const symbol of this.appConfig.supportedSymbols) {
      try {
        const quote = await this.getPrice(symbol);
        this.onQuote?.(quote);
      } catch {
        // Skeleton provider: keep the backend alive when third-party market data is unavailable.
      }
    }
  }
}

export function createMarketDataProvider(
  appConfig: AppConfig,
): MarketDataProvider {
  switch (appConfig.marketDataProvider) {
    case "mock":
      return new MockMarketDataProvider(
        appConfig.defaultSymbol,
        appConfig.defaultBtcPrice,
      );
    case "coingecko":
      return new CoinGeckoMarketDataProvider(appConfig);
    case "pyth":
      return new PythMarketDataProvider(appConfig);
    default:
      throw badRequest(
        "UNSUPPORTED_MARKET_DATA_PROVIDER",
        `Unsupported MARKET_DATA_PROVIDER: ${appConfig.marketDataProvider}`,
      );
  }
}

function createQuote(
  symbol: string,
  price: number,
  source: string,
  timestamp = new Date().toISOString(),
  confidence?: number,
  raw?: unknown,
): Quote {
  return {
    symbol: symbol.toUpperCase(),
    price: roundMoney(price),
    source,
    timestamp,
    ts: timestamp,
    ...(confidence === undefined ? {} : { confidence: roundMoney(confidence) }),
    ...(raw === undefined ? {} : { raw }),
  };
}

function mapCoinGeckoSymbol(
  symbol: string,
): { coinId: string; vsCurrency: string } | null {
  switch (symbol.toUpperCase()) {
    case "BTC-USD":
      return { coinId: "bitcoin", vsCurrency: "usd" };
    case "ETH-USD":
      return { coinId: "ethereum", vsCurrency: "usd" };
    default:
      return null;
  }
}

type PythLatestPriceResponse = {
  parsed?: Array<{
    price?: {
      price?: string;
      conf?: string;
      expo?: number;
      publish_time?: number;
    };
  }>;
};

function parsePythPrice(raw: PythLatestPriceResponse): {
  price: number;
  confidence: number;
  publishTime: number;
} {
  const priceData = raw.parsed?.[0]?.price;
  const price = Number(priceData?.price);
  const confidence = Number(priceData?.conf ?? 0);
  const expo = Number(priceData?.expo ?? 0);
  const publishTime = Number(
    priceData?.publish_time ?? Math.floor(Date.now() / 1000),
  );

  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(expo)) {
    throw conflict(
      "MARKET_DATA_UNAVAILABLE",
      "Pyth response has no usable price",
    );
  }

  const scale = 10 ** expo;
  return {
    price: price * scale,
    confidence: confidence * scale,
    publishTime,
  };
}
