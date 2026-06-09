import type { FastifyInstance } from "fastify";
import type { Ledger } from "../../core/storage/gatewayLedger.js";
import type { MarketDataService } from "./marketData.js";
import type { AppConfig } from "../../config.js";
import { userAddressParamsSchema } from "../../utils/validation.js";
import {
  addressParamSchema,
  errorResponses,
  portfolioSchema,
  positionSchema,
} from "../../docs/openapiSchemas.js";

export async function portfolioRoutes(
  app: FastifyInstance,
  ledger: Ledger,
  marketData: MarketDataService,
  appConfig: AppConfig,
): Promise<void> {
  app.get(
    "/portfolio/:userAddress",
    {
      schema: {
        tags: ["Collateral"],
        summary: "Get gateway portfolio/collateral snapshot",
        description:
          "Returns the current gateway ledger snapshot for a user, including collateral, equity, pending settlement amount, pending/approved withdrawals and any example application state stored in the reference ledger.",
        params: addressParamSchema("userAddress"),
        response: {
          200: { description: "Portfolio snapshot", ...portfolioSchema },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { userAddress } = userAddressParamsSchema.parse(request.params);
      return ledger.snapshot(
        userAddress,
        (symbol) => marketData.getQuote(symbol).price,
        appConfig.maxLeverage,
      );
    },
  );

  app.get(
    "/examples/trading/positions/:userAddress",
    {
      schema: {
        tags: ["Trading Example"],
        summary: "Get trading example positions",
        description:
          "Returns only the reference trading example positions for a gateway user.",
        params: addressParamSchema("userAddress"),
        response: {
          200: {
            description: "Trading positions",
            type: "object",
            required: ["userAddress", "positions", "ts"],
            properties: {
              userAddress: { type: "string" },
              positions: { type: "array", items: positionSchema },
              ts: { type: "string", format: "date-time" },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { userAddress } = userAddressParamsSchema.parse(request.params);
      const portfolio = ledger.snapshot(
        userAddress,
        (symbol) => marketData.getQuote(symbol).price,
        appConfig.maxLeverage,
      );
      return {
        userAddress: portfolio.userAddress,
        positions: portfolio.positions,
        ts: portfolio.ts,
      };
    },
  );
}
