import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { MarketDataService } from "./marketData.js";
import { requireAdminAuth } from "../../core/auth/adminAuth.js";
import {
  manualPriceSchema,
  symbolParamsSchema,
} from "../../utils/validation.js";
import {
  errorResponses,
  quoteSchema,
  symbolParamSchema,
} from "../../docs/openapiSchemas.js";

const manualPriceRequestSchema = {
  type: "object",
  required: ["price"],
  properties: {
    price: { type: "number", exclusiveMinimum: 0, example: 67000 },
    timestamp: { type: "string", format: "date-time" },
  },
};

export async function marketRoutes(
  app: FastifyInstance,
  marketData: MarketDataService,
  appConfig: AppConfig,
): Promise<void> {
  const requireAdmin = requireAdminAuth(appConfig);
  app.get(
    "/examples/trading/market",
    {
      schema: {
        tags: ["Trading Example"],
        summary: "List latest market quotes",
        description:
          "Returns the latest quotes used by the reference trading example. Market data is part of the example app, not required for generic gateway integrations.",
        response: {
          200: {
            description: "All latest quotes",
            type: "array",
            items: quoteSchema,
          },
          ...errorResponses,
        },
      },
    },
    async () => marketData.allQuotes(),
  );

  app.get(
    "/examples/trading/market/:symbol",
    {
      schema: {
        tags: ["Trading Example"],
        summary: "Get latest quote for symbol",
        description:
          "Returns the latest market quote for one trading-example symbol.",
        params: symbolParamSchema,
        response: {
          200: { description: "Latest quote", ...quoteSchema },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { symbol } = symbolParamsSchema.parse(request.params);
      return marketData.getQuote(symbol);
    },
  );

  app.post(
    "/examples/trading/market/:symbol/refresh",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Trading Example"],
        summary: "Refresh quote from configured provider",
        description:
          "Requests a fresh quote from the configured MarketDataProvider.",
        params: symbolParamSchema,
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: { description: "Refreshed quote", ...quoteSchema },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { symbol } = symbolParamsSchema.parse(request.params);
      return marketData.refresh(symbol);
    },
  );

  app.post(
    "/examples/trading/market/:symbol/price",
    {
      preHandler: requireAdmin,
      schema: {
        tags: ["Trading Example"],
        summary: "Set mock market price",
        description:
          "Updates the mock provider price for the reference trading example. This requires MARKET_DATA_PROVIDER=mock and is intended for deterministic tests, local demos and example walkthroughs.",
        params: symbolParamSchema,
        body: manualPriceRequestSchema,
        security: [{ AdminBearerAuth: [] }],
        response: {
          200: { description: "Updated mock quote", ...quoteSchema },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { symbol } = symbolParamsSchema.parse(request.params);
      const body = manualPriceSchema.parse(request.body);
      return marketData.setPrice(symbol, body.price, body.timestamp);
    },
  );
}
