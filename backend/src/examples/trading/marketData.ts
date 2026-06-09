import type { AppConfig } from "../../config.js";
import type { Quote } from "../../types/domain.js";
import { conflict, notFound } from "../../utils/errors.js";
import {
  createMarketDataProvider,
  MockMarketDataProvider,
  type MarketDataProvider,
} from "./marketDataProvider.js";

export type MarketDataServiceOptions = {
  provider?: MarketDataProvider;
  onQuote?: (quote: Quote) => void;
};

export class MarketDataService {
  private readonly quotes = new Map<string, Quote>();
  private readonly provider: MarketDataProvider;
  private readonly onQuote?: (quote: Quote) => void;
  private started = false;
  private readonly maxPriceAgeMs: number;

  constructor(defaultSymbol: string, defaultPrice: number);
  constructor(appConfig: AppConfig, options?: MarketDataServiceOptions);
  constructor(
    appConfigOrDefaultSymbol: AppConfig | string,
    defaultPriceOrOptions?: number | MarketDataServiceOptions,
  ) {
    if (typeof appConfigOrDefaultSymbol === "string") {
      const provider = new MockMarketDataProvider(
        appConfigOrDefaultSymbol,
        Number(defaultPriceOrOptions),
      );
      this.provider = provider;
      this.maxPriceAgeMs = 60_000;
      for (const quote of provider.initialQuotes()) {
        this.quotes.set(quote.symbol, quote);
      }
      return;
    }

    const options = (defaultPriceOrOptions ?? {}) as MarketDataServiceOptions;
    this.provider =
      options.provider ?? createMarketDataProvider(appConfigOrDefaultSymbol);
    this.onQuote = options.onQuote;
    this.maxPriceAgeMs = appConfigOrDefaultSymbol.maxPriceAgeMs;

    if (this.provider instanceof MockMarketDataProvider) {
      for (const quote of this.provider.initialQuotes()) {
        this.quotes.set(quote.symbol, quote);
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return;

    await this.provider.start((quote) => this.ingestQuote(quote, true));
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.provider.stop();
    this.started = false;
  }

  async refresh(symbol: string): Promise<Quote> {
    const quote = await this.provider.getPrice(symbol);
    return this.ingestQuote(quote, true);
  }

  getQuote(symbol: string): Quote {
    const quote = this.quotes.get(symbol.toUpperCase());
    if (!quote) throw notFound("SYMBOL_NOT_FOUND", `Unknown symbol: ${symbol}`);
    return quote;
  }

  setPrice(
    symbol: string,
    price: number,
    timestamp = new Date().toISOString(),
  ): Quote {
    if (!(this.provider instanceof MockMarketDataProvider)) {
      throw conflict(
        "MARKET_DATA_PROVIDER_NOT_MUTABLE",
        "Manual price updates are only available with MARKET_DATA_PROVIDER=mock",
      );
    }

    const quote = this.provider.setPrice(symbol, price, timestamp);
    return this.ingestQuote(quote, true);
  }

  isStale(symbol: string, now = Date.now()): boolean {
    const quote = this.getQuote(symbol);
    return this.quoteAgeMs(quote, now) > this.maxPriceAgeMs;
  }

  assertFresh(quote: Quote, now = Date.now()): void {
    const ageMs = this.quoteAgeMs(quote, now);
    if (ageMs > this.maxPriceAgeMs) {
      throw conflict(
        "STALE_PRICE",
        `Quote for ${quote.symbol} is stale. Age=${ageMs}ms, maxPriceAgeMs=${this.maxPriceAgeMs}`,
      );
    }
  }

  allQuotes(): Quote[] {
    return [...this.quotes.values()];
  }

  private ingestQuote(quote: Quote, publish: boolean): Quote {
    const normalized: Quote = {
      ...quote,
      symbol: quote.symbol.toUpperCase(),
      timestamp: quote.timestamp ?? quote.ts,
      ts: quote.ts ?? quote.timestamp,
    };
    this.quotes.set(normalized.symbol, normalized);
    if (publish) this.onQuote?.(normalized);
    return normalized;
  }

  private quoteAgeMs(quote: Quote, now: number): number {
    const quoteTime = Date.parse(quote.timestamp ?? quote.ts);
    if (!Number.isFinite(quoteTime)) {
      throw conflict(
        "STALE_PRICE",
        `Quote for ${quote.symbol} has an invalid timestamp`,
      );
    }
    return now - quoteTime;
  }
}
